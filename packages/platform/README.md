# @void/platform

Public, target-neutral contracts and packaged runtime artifacts for installing a Void company platform in a Cloudflare account.

For a first installation, follow [Install a Void Platform](../../docs/guide/self-hosted-platform.md). It explains how to prepare the Cloudflare account, domain, PostgreSQL database, and credentials before deploying. Void creates the platform resources and database tables.

The CLI provides direct credential setup links in plans and opens missing-credential pages during an approved interactive install. The runtime-token link preselects all required account permissions, including Workers Tail, Hyperdrive, and AI Gateway when needed, with a readable fallback summary. Local credential drafts preserve the final Worker names and OAuth callback before provisioning, with partial secrets encrypted by the existing recovery store. A completed credential-setup marker separates these drafts from database-claimed installation recovery.

Interactive installation lists unfinished installs, including interrupted provisioning, and offers to continue one or start a new platform install. Entering an existing unfinished name asks to resume it; declining returns to name entry. New installs leave previous setup, credentials, and resources untouched. Completed platforms are excluded. Explicit `--resume` skips the choice; non-interactive recovery requires it. Read-only plans do not save drafts. Their printed install command preserves the API hostname choice, Hyperdrive selection, login methods, Access protection, and domain settings.

New platforms use readable resource names such as `void-team-api` and `void-team-routing`, without random suffixes. Choose an installation name that is unused in the selected account. Conflicting resources are never silently adopted, overwritten, or bypassed by choosing random names. Existing installations keep their recorded resource names, including older suffixed names; application/user resource naming is independent.

The packaged API also serves the `void platform` commands for managing users,
projects, access, and logs. The installer applies the database migration needed
for administrator sessions and audit records. See
[Platform Administration](../../docs/guide/platform-administration.md) to operate
an installed platform from your terminal.

Platforms can use GitHub, Google, generic OIDC, Cloudflare Access, or a combination.
Access protection is independent from login methods and can admit company-approved
users automatically. Login settings, explicit account linking, and provider recovery
are available through Void; upgrades preserve live settings and reject runtimes
that cannot enforce their session revocation. See the installation and administration
guides for setup, scoped CI credentials, and recovery requirements.

The package contains:

- versioned deployment and installation manifests
- deterministic resource naming and application-route generation
- discovery-document and capability contracts
- Cloudflare Worker configuration generation for the API, proxy, tail, dispatch, and email gateway Workers
- A shared installation-owned traffic-disable protocol used by lifecycle-safe retained Workers
- integrity-checked, deployable Worker bundles plus a schema-versioned PostgreSQL migration and rollback-compatibility manifest under the `./installer` export

The `void` CLI consumes this package for `void platform install`, `repair`, `upgrade`, `discover`, and `uninstall`. Platform implementation sources remain under `platform/packages/*`; their deployable core output is bundled here so a user installs one normal public `void` package rather than cloning or deploying the repository.

Interactive lifecycle operations authenticate the human operator through Cloudflare browser sign-in with OS-keychain storage. Wrangler browser OAuth has Zone Read, so plans that create a zone or DNS record require an explicit management API token with the corresponding Zone Edit and DNS Edit permissions. A new account must finish Workers onboarding and choose its workers.dev subdomain before planning. The installed control plane receives a separate scoped runtime token. Its core permissions include Hyperdrive: Write at account scope and Cache Purge: Purge on the application zone; SSL and Certificates: Edit is needed only by a custom runtime that enables custom project domains. The installer preflights account and Hyperdrive access and, for an existing zone, verifies cache-purge access with a unique nonexistent URL. Local recovery checkpoints are AES-256-GCM encrypted with a key held in the OS keychain; normal upgrades preserve existing Cloudflare Worker secrets rather than downloading or rewriting them.

Fresh installations require a unique JWT signing secret with at least 32 bytes of random material and a unique, canonical base64-encoded 32-byte project-encryption key from the operator's durable secret manager. The installer never makes an ephemeral workstation or CI registry the only custodian of these installation identity keys. Existing Workers preserve their deployed values during routine lifecycle operations.

Email-enabled installations also need an independent email signing key. The installer generates it in encrypted recovery state, or accepts `VOID_PLATFORM_EMAIL_SIGNING_SECRET` from the operator's secret manager. Keep that original value for recovery on another machine and for headless upgrades without persistent recovery files.

Browser OAuth cannot manage AI Gateway. Installation previews mark an inaccessible gateway as requiring inspection; apply rechecks it with the already-required runtime token (AI Gateway: Edit) before provisioning. All other provider operations keep the operator credential. Later OAuth lifecycle operations can reuse that token from encrypted local recovery storage. On another workstation, use a management API token with AI Gateway access or supply the runtime token explicitly for that check.

Runtime and installation manifests record the last usage protocol proven live across the complete Worker set. A protocol transition gates traffic before the first Worker update and opens it only after target health and immutable versions pass; interrupted transitions remain gated and resumable.

Application-addressing contracts preserve schema v1 for existing domain installations. Schema v2 records an optional workers.dev installation identity, retained when a domain is added. Project ingress names include the stable project ID so a deleted project's hostname cannot be inherited by a later project with the same slug.

`void platform install --workers-dev` is the explicit test path; the interactive default recommends a domain. `void platform domain set <domain>` records pending setup separately and publishes the active routing configuration only after DNS, runtime-token permissions, and HTTPS pass. It preserves the API origin and existing test URLs. The test hostnames bypass the additional edge response cache while retaining shared ISR storage; custom-domain traffic keeps the normal cache path.

Maintainers and platform forks can build the same runtime from source with `vp run --filter @void/platform build` and deploy it using `void platform upgrade --runtime packages/platform/dist/runtime`. The custom path does not bypass release safety: its manifest, Worker bundles, migration journal, and SQL files receive the same integrity and compatibility verification as packaged artifacts. Builds from a Git checkout automatically record `HEAD` in the runtime provenance, with a `-dirty` suffix when the checkout has uncommitted files. Build systems can set `VOID_PLATFORM_SOURCE_REVISION` to override automatic detection with another commit or build identifier; source archives without Git metadata leave it unrecorded.

Runtime artifacts include migration SQL, the journal, and compatibility metadata. Drizzle authoring snapshots stay in the source tree and are excluded from the published runtime.

Platform migrations are forward-only. `platform/packages/api/drizzle/compatibility.json` declares exact source-version/schema-digest edges whose old Workers are safe against the target schema. The runtime build validates that each source digest is a prefix of the same PostgreSQL lineage and hashes the journal and every SQL file. When adding a migration, use an expand-compatible change, add only edges verified against the old runtime, and keep destructive contract cleanup for a later release after rollback to the old Workers is no longer possible.

After rollback, an older runtime may stop partway through deleting a project that uses shared email or refuse to rename it. Restore the current runtime and reconcile the project's shared recipient cleanup before retrying deletion or renaming.

Post-success rollback uses the installed runtime's integrity-checked compatibility manifest and an explicitly supplied earlier runtime. The installation checkpoint records running-runtime provenance separately from the actual forward-only database schema. Rollback never reverses migrations, and it rejects a target whose declared safety protocols are older than the installation or authoritative database state.

See the [self-hosted platform guide](../../docs/guide/self-hosted-platform.md) for the supported core feature set, Cloudflare footprint, and lifecycle commands.

Use the application zone's apex for the simplest certificate setup. Nested app
domains require an active edge wildcard certificate; planning checks coverage
before provisioning and explains the required certificate product and read
permission when coverage is missing.

For local changes, fork CI, and a complete source-runtime example, see
[Platform Development](../../docs/guide/platform-development.md).
