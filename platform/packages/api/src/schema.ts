import type {
  PlatformAccessProtection,
  PlatformAdmissionPolicy,
  PlatformLoginConfiguration,
  PlatformLoginKind,
} from '@void/platform';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { PlatformWorkerName, PlatformEnv } from './admin/platform-workers.ts';
import type { PlatformOidcIdentity, CompanyIdentity } from './auth/identity-types.ts';
import type { PlanId } from './tiers.ts';
import type { InvitationStatus } from './types.ts';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('github'),
    provider_id: text('provider_id').notNull().default(''),
    login: text('login').notNull().default(''),
    email: text('email'),
    plan: text('plan').notNull().default('free').$type<PlanId>(),
    role: text('role').notNull().default('user').$type<'user' | 'admin'>(),
    billing_cycle_start: timestamp('billing_cycle_start', { mode: 'string' })
      .notNull()
      .defaultNow(),
    suspended_reason: text('suspended_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_users_provider_id').on(table.provider, table.provider_id),
    index('idx_users_email').on(table.email),
  ],
);

// ---------------------------------------------------------------------------
// oauth_accounts
// ---------------------------------------------------------------------------
export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    provider_id: text('provider_id').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_oauth_accounts_provider_id').on(table.provider, table.provider_id),
    index('idx_oauth_accounts_user_id').on(table.user_id),
  ],
);

// Platform authentication is database-authoritative after its one-time import.
// Lock the singleton before changing connections, admission, or administrator reachability.
export const platformAuthSettings = pgTable(
  'platform_auth_settings',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    revision: integer('revision').notNull().default(1),
    admission: jsonb('admission').notNull().$type<PlatformAdmissionPolicy>(),
    protection: jsonb('protection').$type<PlatformAccessProtection>(),
    session_seconds: integer('session_seconds').notNull().default(2592000),
    sessions_required: boolean('sessions_required').notNull().default(false),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('platform_auth_settings_singleton', sql`${table.singleton} = true`),
    check('platform_auth_settings_revision', sql`${table.revision} > 0`),
    check(
      'platform_auth_settings_session_seconds',
      sql`${table.session_seconds} BETWEEN 300 AND 2592000`,
    ),
  ],
);

export const platformLoginConnections = pgTable(
  'platform_login_connections',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<PlatformLoginKind>(),
    enabled: boolean('enabled').notNull().default(false),
    active_revision: integer('active_revision'),
    revision: integer('revision').notNull().default(1),
    generation: integer('generation').notNull().default(1),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'platform_login_connections_kind',
      sql`${table.kind} IN ('github', 'google', 'oidc', 'cloudflare-access')`,
    ),
    check(
      'platform_login_connections_revision',
      sql`${table.revision} > 0 AND ${table.generation} > 0`,
    ),
    check(
      'platform_login_connections_active_revision',
      sql`${table.active_revision} IS NULL OR ${table.active_revision} BETWEEN 1 AND ${table.revision}`,
    ),
    check(
      'platform_login_connections_enabled',
      sql`NOT ${table.enabled} OR ${table.active_revision} IS NOT NULL`,
    ),
  ],
);

/** Immutable revisions keep a credential edit separate from the working login method. */
export const platformLoginRevisions = pgTable(
  'platform_login_revisions',
  {
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    configuration: jsonb('configuration').notNull().$type<PlatformLoginConfiguration>(),
    secret: jsonb('secret')
      .notNull()
      .$type<{ ciphertext: string; iv: string; keyVersion: string }>(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connection_id, table.revision] })],
);

export const platformLoginIdentities = pgTable(
  'platform_login_identities',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    last_authenticated_at: timestamp('last_authenticated_at', {
      mode: 'string',
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('platform_login_identity_subject').on(
      table.connection_id,
      table.issuer,
      table.subject,
    ),
    uniqueIndex('platform_login_identity_user').on(table.connection_id, table.user_id),
  ],
);

export const platformHumanSessions = pgTable(
  'platform_human_sessions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    generation: integer('generation').notNull(),
    audience: text('audience').notNull().$type<'api' | 'admin'>(),
    // When a company gate is required, both identities must belong to the same person.
    access_issuer: text('access_issuer'),
    access_subject: text('access_subject'),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('platform_human_sessions_connection').on(table.connection_id),
    index('platform_human_sessions_user').on(table.user_id),
    index('platform_human_sessions_expiry').on(table.expires_at),
    check('platform_human_sessions_audience', sql`${table.audience} IN ('api', 'admin')`),
    check(
      'platform_human_sessions_access_identity',
      sql`(${table.access_issuer} IS NULL) = (${table.access_subject} IS NULL)`,
    ),
  ],
);

export const platformCompanyIdentities = pgTable(
  'platform_company_identities',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    uniqueIndex('platform_company_identity_user').on(table.issuer, table.user_id),
  ],
);

export const platformLoginTests = pgTable(
  'platform_login_tests',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    login: text('login').notNull().default(''),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [index('platform_login_tests_expiry').on(table.expires_at)],
);

export const platformAuthAttempts = pgTable(
  'platform_auth_attempts',
  {
    id: text('id').primaryKey(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    revision: integer('revision').notNull(),
    generation: integer('generation').notNull(),
    purpose: text('purpose').notNull().$type<'login' | 'admin' | 'test' | 'link' | 'bootstrap'>(),
    browser_hash: text('browser_hash').notNull(),
    // Contains the upstream PKCE verifier and callback context; consumed atomically.
    context: jsonb('context').notNull().$type<Record<string, unknown>>(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [index('platform_auth_attempts_expiry').on(table.expires_at)],
);

export const platformAuthBootstrap = pgTable(
  'platform_auth_bootstrap',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    installation_id: text('installation_id').notNull(),
    credential_hash: text('credential_hash').notNull(),
    request_hash: text('request_hash').notNull().default(''),
    claim_hash: text('claim_hash'),
    pending_identity: jsonb('pending_identity').$type<{
      revision: number;
      generation: number;
      identity: PlatformOidcIdentity;
      companyIdentity?: CompanyIdentity;
      expiresAt: string;
    }>(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => platformLoginConnections.id),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    consumed_at: timestamp('consumed_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [check('platform_auth_bootstrap_singleton', sql`${table.singleton} = true`)],
);

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    slug: text('slug').notNull(),
    type: text('mode').notNull().default('worker').$type<'void' | 'spa' | 'static' | 'framework'>(),
    active_deployment_id: text('active_deployment_id'),
    websocket_version: integer('websocket_version').notNull().default(0),
    status: text('status').notNull().default('active').$type<'active' | 'deleting'>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.user_id, table.slug),
    uniqueIndex('idx_projects_slug').on(table.slug),
    index('idx_projects_user_id').on(table.user_id),
  ],
);

// Revocable project-scoped credentials for headless CI. The bearer value is a
// signed aud:deploy JWT; this row is the authoritative revocation and expiry
// record checked on every request. Human login-provider lifecycle does not
// revoke these independent deployment credentials.
export const projectDeployCredentials = pgTable(
  'project_deploy_credentials',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issued_by: text('issued_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    expires_at: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('project_deploy_credentials_project').on(table.project_id, table.created_at),
    index('project_deploy_credentials_expiry').on(table.expires_at),
    check('project_deploy_credentials_name', sql`length(${table.name}) BETWEEN 1 AND 80`),
  ],
);

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------
export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<
        | 'pending'
        | 'uploading'
        | 'migrating'
        | 'prerendering'
        | 'cutover'
        | 'compensating'
        | 'canceling'
        | 'live'
        | 'failed'
        | 'canceled'
      >(),
    manifest: text('manifest'),
    source: text('source'),
    commit: text('commit'),
    repository_url: text('repository_url'),
    commit_url: text('commit_url'),
    git_ref: text('git_ref'),
    cli_version: text('cli_version'),
    admission_protocol: integer('admission_protocol')
      .notNull()
      .default(0)
      .$default(() => 2),
    error_message: text('error_message'),
    asset_hashes: text('asset_hashes'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
    deployed_at: timestamp('deployed_at', { mode: 'string' }),
    retained: boolean('retained').notNull().default(false),
    applied_migrations: text('applied_migrations'),
    bundle_stored: boolean('bundle_stored').notNull().default(false),
  },
  (table) => [
    index('idx_deployments_project_id').on(table.project_id, table.created_at),
    index('idx_deployments_project_status').on(table.project_id, table.status),
    index('idx_deployments_created_id').on(table.created_at, table.id),
  ],
);

// ---------------------------------------------------------------------------
// project_secrets
// ---------------------------------------------------------------------------
export const projectSecrets = pgTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    key_version: text('key_version').notNull(),
    managed_reason: text('managed_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.project_id, table.name),
    index('idx_project_secrets_project_id').on(table.project_id),
  ],
);

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------
export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    type: text('type').notNull().$type<'d1' | 'kv' | 'r2' | 'queue' | 'hyperdrive' | 'container'>(),
    cf_id: text('cf_id').notNull(),
    binding_name: text('binding_name').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.project_id, table.type, table.binding_name)],
);

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------
export type DomainVerificationData = Readonly<{
  ownership_verification?: Readonly<{
    type: 'txt';
    name: string;
    value: string;
  }>;
  ssl_validation_records?: ReadonlyArray<
    Readonly<{
      txt_name?: string;
      txt_value?: string;
      status?: string;
    }>
  >;
}>;

export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    hostname: text('hostname').notNull().unique(),
    cf_hostname_id: text('cf_hostname_id').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'active'>(),
    verification_data: jsonb('verification_data').$type<DomainVerificationData | null>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_domains_project_id').on(table.project_id, table.created_at)],
);

// ---------------------------------------------------------------------------
// email_destinations
// Per-project verified destination addresses for outbound email via the
// shared platform sender (`EMAIL_SENDER_DOMAIN`, e.g. `mail.void.cloud` in
// production and `mail.staging.void.cloud` in staging — never hard-coded).
// Each row tracks the lifecycle of one recipient address — from "the user
// added it" -> CF sends a verification email -> recipient clicks the link ->
// status flips to "verified" and the next deploy puts the address into the
// worker's `send_email` binding `allowed_destination_addresses` allowlist.
//
// `cf_destination_id` is CF's account-level identifier for the address —
// destinations are account-wide on CF's side; per-project scoping is
// enforced via the binding allowlist injected at deploy.
// ---------------------------------------------------------------------------
export const emailDestinations = pgTable(
  'email_destinations',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'verified'>(),
    // Always populated by `createEmailDestination` after a successful CF
    // addDestination call. Nullable in schema only for forward-compat with
    // future async-tag flows (e.g. status='pending' rows created before the
    // CF API has returned a tag).
    cf_destination_id: text('cf_destination_id'),
    // Audit timestamp: set the moment status first transitions to 'verified',
    // never cleared. Use `status === 'verified'` for current state, not
    // `verified_at !== null`.
    verified_at: timestamp('verified_at', { mode: 'string' }),
    // How the row reached `status='verified'`:
    //   - 'cf'       — Cloudflare Email Routing's verification email was
    //                   clicked (the default path). Includes the project
    //                   owner's own email when CF already had it verified
    //                   on a prior project (Option C: owner-relaxed reuse).
    //   - 'platform' — CF already had the address verified by a *different*
    //                   project. We cannot trust CF's verification flag for
    //                   per-project consent here, so we issue our own
    //                   single-use confirmation link to the recipient and
    //                   keep the row 'pending' until they click it. Once
    //                   the platform link is clicked, status flips to
    //                   'verified' but `verification_source` stays
    //                   'platform' for the audit trail.
    verification_source: text('verification_source')
      .notNull()
      .default('cf')
      .$type<'cf' | 'platform'>(),
    // Audit columns for owner-relaxed CF reuse (Option C in design doc
    // 0078). Populated only when:
    //   - `verification_source = 'cf'` AND
    //   - the row was inserted via the owner-relaxed branch (the
    //     address matched the project owner's `users.email` at
    //     insert-time and CF already had it verified).
    //
    // NULL for `verification_source = 'platform'` rows (no inheritance
    // — consent was per-recipient via the platform-side click) and for
    // fresh-CF-verification rows (no prior consent inherited).
    //
    // `verified_by_email_snapshot` is the email value the granter held
    // at insert-time. If the granter's `users.email` later changes, the
    // snapshot is how `revokeOwnerVerifiedDestinationsForUserChange`
    // identifies which inherited-consent rows to invalidate (the
    // identity that consented is no longer the user's identity).
    verified_by_user_id: text('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verified_by_email_snapshot: text('verified_by_email_snapshot'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    unique('email_destinations_project_address_uq').on(table.project_id, table.address),
    index('idx_email_destinations_project_id').on(table.project_id),
    index('idx_email_destinations_cf_destination_id').on(table.cf_destination_id),
    index('idx_email_destinations_verified_by_user_id').on(
      table.verified_by_user_id,
      table.verified_by_email_snapshot,
    ),
    // CHECK constraints are declared HERE, not only in raw migration SQL.
    // A `drizzle-kit generate` run diffs the schema against the previous
    // snapshot: an undeclared constraint reads as "dropped" and the next
    // migration would silently widen the consent gate.
    check('email_destinations_status_check', sql`${table.status} IN ('pending', 'verified')`),
    check(
      'email_destinations_verification_source_check',
      sql`${table.verification_source} IN ('cf', 'platform')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// email_domains
// Per-project custom email domains on the customer's own Cloudflare zone
// (design doc 0078, "Custom domains on Cloudflare"). The customer grants a
// scoped credential once — an OAuth grant refresh token, or a pasted API
// token on the fallback path — and the platform configures the zone, deploys
// a relay worker into the customer's account for inbound, and sends outbound
// through CF's REST send_raw with a leased credential.
//
// Two encrypted values per row, each an AES-GCM ciphertext/iv/key_version
// triple from `encryptProjectSecret` under a FIXED AAD name per row
// (`email-domain-token:<domain>` / `email-domain-relay:<domain>` — the AAD is
// `${projectId}:${name}`, so each ciphertext is bound to project AND domain):
//   - token_* — the grant refresh token OR the pasted API token. Only the
//     api decrypts it (probes, relay deploys, the OAuth refresh chain); the
//     proxy leases short-lived credentials from the api instead of holding it.
//   - relay_* — the relay secret (random 32 bytes, base64url, generated by
//     the api at add time). Only its sha256 hex is mirrored to ROUTING KV;
//     the plaintext is never logged, returned, or written to a manifest.
//
// Lifecycle columns are nullable because EVERY orchestration failure leaves
// the row 'failed' with `setup_state` naming the failed step, no matter how
// early: `zone_id`/`account_id` are known only after the zone lookup,
// `mode` after the public-DNS MX check, and `relay_worker_name`/
// `relay_version` only once the relay is deployed (its name gains a '-2',
// '-3'… suffix on collision within the account). `token_id`/
// `token_expires_on` come from GET /user/tokens/verify and stay null on the
// oauth_grant path. `relay_worker_name` never changes after deploy —
// renaming a worker detaches every routing rule that points at it.
// ---------------------------------------------------------------------------
export type EmailDomainSetupState = Readonly<{
  /** Orchestration step that left the row 'failed' (e.g. 'zone_lookup'). */
  failed_step?: string;
  /** Steps still owed by the human (e.g. the routing-subdomain dashboard form). */
  remaining_steps?: ReadonlyArray<string>;
  /** CF steps a remove failed on ('catch_all', 'delete_relay', 'revoke_grant'); the row is KEPT for retry/force. */
  removal_failed_steps?: ReadonlyArray<string>;
}>;

export const emailDomains = pgTable(
  'email_domains',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    zone_id: text('zone_id'),
    account_id: text('account_id'),
    mode: text('mode').$type<'apex' | 'subdomain'>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'active' | 'token_revoked' | 'token_expired' | 'failed'>(),
    // `platform` rows carry no credential of their own: the engine and the
    // lease resolve them to the runtime token (`CF_API_TOKEN`), so their
    // `token_*` triple is null — the CHECK below pins that pairing.
    credential_kind: text('credential_kind')
      .notNull()
      .$type<'oauth_grant' | 'api_token' | 'platform'>(),
    token_ciphertext: text('token_ciphertext'),
    token_iv: text('token_iv'),
    token_key_version: text('token_key_version'),
    // Who registered the row. An administrator's row runs on the platform's
    // credential; owners may read it but not sync or remove it.
    managed_by: text('managed_by').notNull().default('owner').$type<'owner' | 'admin'>(),
    relay_ciphertext: text('relay_ciphertext').notNull(),
    relay_iv: text('relay_iv').notNull(),
    relay_key_version: text('relay_key_version').notNull(),
    relay_worker_name: text('relay_worker_name'),
    relay_version: integer('relay_version'),
    token_id: text('token_id'),
    token_expires_on: timestamp('token_expires_on', { mode: 'string' }),
    // The CLI add attempt that last wrote the credential — lets a CLI that
    // lost the POST's answer tell its own committed row apart from the
    // pre-existing one. Null on rows written by an older CLI.
    attempt_id: text('attempt_id'),
    setup_state: jsonb('setup_state').$type<EmailDomainSetupState | null>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // A domain is GLOBALLY unique, not per-project: the relay secret and
    // the `email-domain:<domain>` KV mirror map to exactly one registered
    // domain of one project (design doc 0078, "Trust"), so two projects can
    // never hold the same domain — one mirror key could not name them both.
    unique('email_domains_domain_uq').on(table.domain),
    index('idx_email_domains_project_id').on(table.project_id),
    // One LIVE row per zone, one relay name per account — the DB backstop
    // for the check-then-write windows the engine cannot close against the
    // CF API (concurrent adds; design doc 0078, fix round 2026-09-17). The
    // zone index covers only live statuses so a 'failed' row can still
    // RECORD the zone it failed in (the catch-all conflict path needs
    // that); the relay index reserves every deployed name outright,
    // because the worker really exists in the account. A violation reads
    // to the route as "another live row won the race" — a 409, never a
    // falsely-active second row.
    uniqueIndex('email_domains_zone_uq')
      .on(table.zone_id)
      .where(sql`${table.zone_id} IS NOT NULL AND ${table.status} IN ('active', 'pending')`),
    uniqueIndex('email_domains_relay_uq')
      .on(table.account_id, table.relay_worker_name)
      .where(sql`${table.relay_worker_name} IS NOT NULL`),
    // The proxy's credential lease (POST /internal/email/domain-credential)
    // resolves rows by domain alone; the domain unique constraint's own
    // index covers those lookups.
    // CHECK constraints are declared HERE, not only in raw migration SQL —
    // same reason as email_destinations: an undeclared constraint reads as
    // "dropped" to the next `drizzle-kit generate` diff.
    check('email_domains_mode_check', sql`${table.mode} IN ('apex', 'subdomain')`),
    check(
      'email_domains_status_check',
      sql`${table.status} IN ('pending', 'active', 'token_revoked', 'token_expired', 'failed')`,
    ),
    check(
      'email_domains_credential_kind_check',
      sql`${table.credential_kind} IN ('oauth_grant', 'api_token', 'platform')`,
    ),
    check(
      'email_domains_platform_token_check',
      sql`(${table.credential_kind} = 'platform' AND ${table.token_ciphertext} IS NULL AND ${table.token_iv} IS NULL AND ${table.token_key_version} IS NULL) OR (${table.credential_kind} <> 'platform' AND ${table.token_ciphertext} IS NOT NULL AND ${table.token_iv} IS NOT NULL AND ${table.token_key_version} IS NOT NULL)`,
    ),
    check('email_domains_managed_by_check', sql`${table.managed_by} IN ('owner', 'admin')`),
  ],
);

// ---------------------------------------------------------------------------
// Installation-scoped settings an administrator changes at runtime (design
// doc 0078, "Recipient policy"). Authoritative here; hot-path readers get a
// ROUTING KV mirror written by the setting's own writer.
// ---------------------------------------------------------------------------
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Operator sessions and mutation audit, separate from browser/deployment auth.
// Audit identities survive account deletion deliberately.
// ---------------------------------------------------------------------------
export const operatorSessions = pgTable(
  'operator_sessions',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    human_session_id: text('human_session_id').references(() => platformHumanSessions.id, {
      onDelete: 'cascade',
    }),
    expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_operator_sessions_expiry').on(table.expires_at)],
);

export const operatorEvents = pgTable(
  'operator_events',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    login: text('login').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    status: text('status').notNull().$type<'pending' | 'success' | 'failed'>(),
    http_status: integer('http_status'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('idx_operator_events_created').on(table.created_at, table.id)],
);

/** Authoritative, serialized checkpoint for the managed Sandbox shutdown. */
export const sandboxDrainCheckpoints = pgTable('sandbox_drain_checkpoints', {
  singleton: boolean('singleton').primaryKey(),
  admission_protocol: integer('admission_protocol').notNull().default(0),
  generation: text('generation').notNull(),
  state: text('state').notNull().$type<'draining' | 'complete'>(),
  phase: text('phase').notNull().$type<'deployments' | 'resources'>(),
  cursor: jsonb('cursor').$type<Record<string, string> | null>(),
  lease_owner: text('lease_owner'),
  lease_expires_at: timestamp('lease_expires_at', { mode: 'string' }),
  started_at: timestamp('started_at', { mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  completed_at: timestamp('completed_at', { mode: 'string' }),
});

// ---------------------------------------------------------------------------
// platform_events (audit log for admin platform rollbacks)
// ---------------------------------------------------------------------------
export const platformEvents = pgTable(
  'platform_events',
  {
    id: text('id').primaryKey(),
    batch_id: text('batch_id'),
    action: text('action').notNull().$type<'rollback' | 'rollback_all'>(),
    worker_name: text('worker_name').notNull().$type<PlatformWorkerName>(),
    environment: text('environment').notNull().$type<PlatformEnv>(),
    version_id: text('version_id').notNull(),
    script_name: text('script_name').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'success' | 'failed' | 'skipped'>(),
    error_message: text('error_message'),
    admin_user_id: text('admin_user_id').notNull(),
    admin_login: text('admin_login').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_platform_events_batch_id').on(table.batch_id),
    index('idx_platform_events_env_created').on(table.environment, table.created_at),
  ],
);

// ---------------------------------------------------------------------------
// oauth_nonces — short-lived, single-use tokens for OAuth CSRF/replay protection.
// Stored in PostgreSQL (not KV) because the login and callback requests can hit
// different CF colos, and KV's eventual consistency would make nonce lookups flaky.
// Atomic DELETE … RETURNING guarantees true single-use semantics.
// ---------------------------------------------------------------------------
export const oauthNonces = pgTable('oauth_nonces', {
  nonce: text('nonce').primaryKey(),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// ---------------------------------------------------------------------------
// auth_codes — short-lived, single-use authorization codes for dashboard login.
// Same rationale as oauth_nonces: cross-colo consistency requires PostgreSQL,
// and atomic DELETE … RETURNING guarantees single-use.
// ---------------------------------------------------------------------------
export const authCodes = pgTable('auth_codes', {
  code: text('code').primaryKey(),
  jwt: text('jwt').notNull(),
  cli_state: text('cli_state'),
  code_challenge: text('code_challenge'),
  code_challenge_method: text('code_challenge_method'),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// ---------------------------------------------------------------------------
// migration_renames — audit log of successfully committed `/migrations/rename`
// pairs. Written inside the same locked transaction as the D1 UPDATE +
// `renameAppliedMigrationsForProject` healing write, so a row exists iff
// both the D1 UPDATE and the pg rewrite have committed.
//
// This table is a durable, rename-specific second corroboration source for
// same-payload retries after a partial-failure heal: a matching row means
// "this exact (project_id, from, to) rename was already committed here, so
// an idempotent retry that observes `to` in D1 and not `from` is genuine
// rather than a fat-fingered request against an unrelated existing migration".
// It is needed because the heal rewrites the active deployment's
// `applied_migrations` to the new name, erasing the active-deployment-based
// corroboration that would otherwise classify the retry.
// ---------------------------------------------------------------------------
export const migrationRenames = pgTable(
  'migration_renames',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    from_name: text('from_name').notNull(),
    to_name: text('to_name').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.from_name, table.to_name] }),
    index('idx_migration_renames_project_id').on(table.project_id),
  ],
);

// ---------------------------------------------------------------------------
// project_migrations — current project database truth
// ---------------------------------------------------------------------------
export const projectMigrations = pgTable(
  'project_migrations',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    applied_at: timestamp('applied_at', { mode: 'string' }).notNull().defaultNow(),
    source_deployment_id: text('source_deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.name] }),
    index('idx_project_migrations_project_id').on(table.project_id, table.applied_at),
  ],
);

// ---------------------------------------------------------------------------
// project_database_credentials
// ---------------------------------------------------------------------------
export const projectDatabaseCredentials = pgTable('project_database_credentials', {
  project_id: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  key_version: text('key_version').notNull(),
  created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// github_installations — GitHub App installations.
//
// `user_id` is nullable to support install-before-signin: a user can install
// the GitHub App before (or instead of) signing in, in which case the
// installation lands here unlinked and is backfilled in the GitHub OAuth
// callback (`linkGitHubInstallationToUser`). `repositories` mirrors the
// installation's repository selection as a JSON array of `{ full_name, id }`.
// ---------------------------------------------------------------------------
export type GitHubInstallationRepository = Readonly<{
  full_name: string;
  id: number;
}>;

export const githubInstallations = pgTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull().unique(),
    // `set null` (not the default NO ACTION): an installation can be linked to a
    // user (backfilled in the OAuth callback), but deleting that user must not
    // fail on this FK. Orphaning the row back to user_id=null returns it to the
    // install-before-signin state, recoverable by re-linking.
    user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    account_login: text('account_login').notNull(),
    account_id: text('account_id').notNull(),
    account_type: text('account_type').notNull().$type<'User' | 'Organization'>(),
    repositories: jsonb('repositories')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<ReadonlyArray<GitHubInstallationRepository>>(),
    // GitHub's `repository_selection`: `all` grants every repo in the account
    // (the `repositories` cache is then irrelevant); `selected` restricts to
    // the cached set. Defaults to `selected` so the OIDC connection lookup
    // requires explicit membership unless a webhook proves an all-repos
    // install — an empty `repositories` array no longer means "all".
    repository_selection: text('repository_selection')
      .notNull()
      .default('selected')
      .$type<'all' | 'selected'>(),
    status: text('status').notNull().default('active').$type<'active' | 'suspended' | 'deleted'>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_github_installations_user_id').on(table.user_id),
    index('idx_github_installations_account_id').on(table.account_id),
  ],
);

// ---------------------------------------------------------------------------
// github_connections — links a project to a GitHub repository + branch.
//
// `project_id` is unique (one connection per project) and cascades on project
// delete (mirrors `project_secrets`). `build_executor` selects which build
// backend runs on push: CF Containers (`container`) or GitHub Actions
// (`github_actions`).
// ---------------------------------------------------------------------------
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    installation_id: text('installation_id').notNull(),
    repo_full_name: text('repo_full_name').notNull(),
    // The repository's immutable numeric GitHub id (as text). A repo can be
    // renamed, deleted, or have its name reused under the same installation, so
    // `repo_full_name` is mutable and unsafe as a routing key — a rename/reuse
    // could match a DIFFERENT repository to this connection and deploy to the
    // wrong project. Webhook (`repository.id`) and OIDC (`claims.repository_id`)
    // resolution match on this immutable id, treating `repo_full_name` as
    // display/fetch metadata. Nominally nullable, but the resolvers FAIL CLOSED:
    // when the caller has an id, a null-id row is NOT matched by `repo_full_name`
    // fallback (a renamed-and-reused name could otherwise authorize the wrong
    // project). New connections always populate it at connect time; the only
    // name fallback left is for callers with no id at all (malformed/partial
    // webhook). A `repo_full_name` match is used solely in that no-id case.
    repository_id: text('repository_id'),
    // The project owner whose own GitHub OAuth token proved access to this
    // organization repository during connect. NULL on legacy rows and personal
    // installations. Runtime authorization accepts an organization connection
    // only when this still names the owning Void user; rows created before the
    // per-repository proof flow therefore fail closed until reconnected.
    authorized_by_user_id: text('authorized_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    branch: text('branch').notNull().default('main'),
    build_executor: text('build_executor')
      .notNull()
      .default('container')
      .$type<'container' | 'github_actions'>(),
    // The `.github/workflows/*.yml` file the GitHub Actions OIDC exchange binds
    // the deploy token to (see `routes/auth-oidc.ts`). Owner-configurable per
    // connection; defaults to the file `void init --github` scaffolds. Only the
    // owner-authenticated connect/update routes write this — never the webhook
    // or the OIDC path — so it stays a trusted, server-side pin.
    workflow_path: text('workflow_path').notNull().default('.github/workflows/void-deploy.yml'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_github_connections_installation_id').on(table.installation_id),
    index('idx_github_connections_repo_full_name').on(table.repo_full_name),
    // Webhook resolution matches on the immutable (installation_id, repository_id).
    index('idx_github_connections_installation_repo_id').on(
      table.installation_id,
      table.repository_id,
    ),
  ],
);

// ---------------------------------------------------------------------------
// github_installation_members — cached org co-membership for the org-shared
// GitHub App installation flow.
//
// Each row records that a Void user (`user_id`) was verified as a member of the
// GitHub account behind a numeric installation (`installation_id`). It is a TTL
// cache (`expires_at`): NO GitHub token is stored — access is re-verified
// per-repo, and this table only short-circuits the org-membership check while
// the cache is fresh. `installation_id` is keyed on GitHub's NUMERIC
// installation id as text with NO `.references()`, deliberately mirroring
// `github_connections.installation_id` (every call site has the numeric id in
// hand). `user_id` cascades on user delete (mirrors `oauth_accounts`).
// `github_account_id` is NULLABLE because the backstop/JOIN paths may not carry
// a caller account id.
// ---------------------------------------------------------------------------
export const githubInstallationMembers = pgTable(
  'github_installation_members',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    github_account_id: text('github_account_id'),
    verified_at: timestamp('verified_at', { mode: 'string' }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the UNIQUE constraint + the onConflict target + the
    // find-members-of-install leading-column scan + composite delete.
    uniqueIndex('idx_github_installation_members_install_user').on(
      table.installation_id,
      table.user_id,
    ),
    // list-for-user + revocation.
    index('idx_github_installation_members_user_id').on(table.user_id),
  ],
);

// ---------------------------------------------------------------------------
// github_installation_revocations — durable per-(installation, github_account) tombstone
//
// Membership rows are a TTL cache that `member_removed` HARD-DELETES, so on their
// own they cannot make revocation MONOTONIC: a removed org member who pre-minted
// a stateless HMAC `join_code`/`connect_grant` could replay it (within its 5-min
// TTL) to recreate a membership/connection that then auto-deploys forever. This
// table records the high-water mark `revoked_at` for
// `(installation_id, github_account_id)`; `member_removed` upserts
// `revoked_at = now()` (always advances). At redemption, the join/complete +
// connect gate compare an artifact's `iat` (mint time) to `revoked_at`: an
// artifact with `iat <= revoked_at` predates the revocation and is rejected, while
// a legit re-join AFTER re-add mints a fresh artifact with `iat > revoked_at` and
// is allowed.
//
// The tombstone keys on the GitHub ACCOUNT id (X), NOT a Void user id: X is the
// durable identity the stateless artifacts carry, and it is the ONLY identity
// `member_removed` reliably knows from the webhook payload (`membership.user.id`).
// A soon-to-be-removed member can pre-mint a join_code + connect_grant while still
// in the org WITHOUT any Void user / membership / oauth-link, so a user-keyed
// tombstone would find no user to key on and write nothing — leaving a
// post-removal replay path. Keying by X closes that hole. `installation_id` keys
// on GitHub's NUMERIC installation id as text with NO FK (mirrors
// `github_installation_members`); `github_account_id` is the NUMERIC GitHub
// account id as text with NO FK — it is not a Void user id and the tombstone must
// outlive Void user deletion.
// ---------------------------------------------------------------------------
export const githubInstallationRevocations = pgTable(
  'github_installation_revocations',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    github_account_id: text('github_account_id').notNull(),
    // `withTimezone` (timestamptz) is LOAD-BEARING here, UNLIKE the rest of the
    // schema's tz-naive `created_at`/`expires_at`. This is the one timestamp the
    // app reads back as an absolute epoch (`extract(epoch from ...) * 1000`) to
    // compare against an artifact's JS `iat` (`Date.now()`). A tz-naive
    // `timestamp` stores `now()` as a session-local WALL CLOCK, and
    // `extract(epoch ...)` then treats those components as UTC — so on any non-UTC
    // session (PGlite in tests picks up the host tz) the extracted epoch is skewed
    // by the offset and the comparison breaks. `timestamptz` stores the true
    // instant, so `extract(epoch ...)` is correct on prod pg (UTC) AND PGlite
    // (host tz) alike. Membership TTLs avoid this only because they compare
    // in-SQL (`expires_at > now()`), never crossing into a JS epoch.
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the UNIQUE constraint + the onConflict target + the single-row
    // (installation_id, github_account_id) lookup at redemption.
    uniqueIndex('idx_github_installation_revocations_install_account').on(
      table.installation_id,
      table.github_account_id,
    ),
  ],
);

// ---------------------------------------------------------------------------
// github_webhook_redeliveries — ledger of GitHub webhook deliveries we asked
// GitHub to REDELIVER (catch-up for missed/failed webhooks, design 0074).
//
// GitHub's own delivery log is the source of truth for what we failed to ack;
// the hourly replay job lists `status=failure` deliveries and re-sends each one
// we have not already retried. The dedup key is GitHub's `guid`, which is stable
// across an event's original delivery AND all of its redeliveries — so keying on
// it retries each failed event at most once, bounding permanently-failing events.
// The remaining columns are audit-only.
// ---------------------------------------------------------------------------
export const githubWebhookRedeliveries = pgTable(
  'github_webhook_redeliveries',
  {
    id: text('id').primaryKey(),
    // GitHub delivery guid — shared across an event's original + redeliveries;
    // the dedup key (unique index below).
    guid: text('guid').notNull(),
    // The numeric GitHub delivery id (as text) we POSTed the attempt for (audit).
    delivery_id: text('delivery_id').notNull(),
    // Event type at time of failure (audit; nullable).
    event: text('event'),
    // The failed delivery's HTTP status (audit; nullable).
    status_code: integer('status_code'),
    redelivered_at: timestamp('redelivered_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    // UNIQUE on guid — serves the onConflictDoNothing target and the
    // already-redelivered lookup, so concurrent runs never double-redeliver.
    uniqueIndex('idx_github_webhook_redeliveries_guid').on(table.guid),
  ],
);

// ---------------------------------------------------------------------------
// builds — server-side build runs (one per push that triggers a build).
//
// A build runs the real `void deploy` CLI in a build environment (CF Container
// or GitHub Actions runner) and produces a `deployment_id` once the deploy
// endpoint accepts the manifest. `executor` records which backend ran it;
// `status` tracks the build lifecycle independent of the deployment's status.
// ---------------------------------------------------------------------------
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    executor: text('executor')
      .notNull()
      .default('container')
      .$type<'container' | 'github_actions'>(),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<
        'queued' | 'starting' | 'building' | 'deploying' | 'complete' | 'failed' | 'cancelled'
      >(),
    commit_sha: text('commit_sha'),
    branch: text('branch'),
    deployment_id: text('deployment_id').references(() => deployments.id),
    github_run_id: text('github_run_id'),
    // The GitHub Actions `run_attempt` (as text, nullable). A workflow RERUN
    // reuses the same `run_id` with an incremented `run_attempt`, so the pair
    // `(github_run_id, github_run_attempt)` — not `run_id` alone — identifies a
    // single attempt. Nullable for backward-compat: container builds and rows
    // created before this column carry NULL. The `workflow_run` completion
    // handler matches on the attempt so a redelivered/late completion from
    // attempt 1 cannot finalize attempt 2's active build.
    github_run_attempt: text('github_run_attempt'),
    logs_url: text('logs_url'),
    // GitHub Check Run id (numeric, stored as text like github_run_id), or NULL.
    // NULL = no check-run was created (Actions builds, builds that failed a
    // pre-create recheck, builds created before this column, or a best-effort
    // create failure). Finalizers no-op when NULL. Additive-only; backward-compat.
    check_run_id: text('check_run_id'),
    error: text('error'),
    exit_code: integer('exit_code'),
    instance_type: text('instance_type'),
    started_at: timestamp('started_at', { mode: 'string' }),
    completed_at: timestamp('completed_at', { mode: 'string' }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_builds_project_created').on(table.project_id, table.created_at),
    index('idx_builds_status').on(table.status),
    index('idx_builds_user_status').on(table.user_id, table.status),
    // A GitHub Actions `run_id` is unique only WITHIN a repository, not
    // globally, so build identity is scoped to the connection's project. The
    // composite partial unique index closes the concurrent-OIDC-exchange race
    // (two ACTIVE rows for one run on the same project) without colliding across
    // projects that happen to share a numeric run_id. `github_run_id IS NULL`
    // rows (the container-build path) are exempt.
    //
    // Scoped to ACTIVE statuses (`starting`/`building`/`deploying`, mirroring
    // `ACTIVE_BUILD_STATUSES` in db.ts): the invariant is "at most one ACTIVE
    // build per (project, run_id, run_attempt)". A GitHub RERUN reuses the same
    // `run_id` with an incremented `run_attempt`, so the attempt is part of the
    // key — two attempts of the same run can be transiently active (e.g. a
    // redelivered late completion for attempt 1 while attempt 2 builds) without
    // violating uniqueness, while a duplicate concurrent insert for the SAME
    // attempt is still rejected. A GitHub RERUN after the prior attempt reaches
    // a terminal status (`complete`/`failed`/`cancelled`) must be able to start
    // a fresh build, so terminal rows are intentionally NOT covered. Rows with a
    // NULL `github_run_attempt` (container builds, or rows created before this
    // column) are not covered by the partial WHERE — fine, this feature is not
    // yet in production.
    uniqueIndex('idx_builds_project_github_run_id')
      .on(table.project_id, table.github_run_id, table.github_run_attempt)
      .where(
        sql`${table.github_run_id} IS NOT NULL AND ${table.github_run_attempt} IS NOT NULL AND ${table.status} IN ('starting', 'building', 'deploying')`,
      ),
  ],
);

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------
export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    status: text('status').notNull().default('pending').$type<InvitationStatus>(),
    // Invitation actor ids are durable audit data. They deliberately outlive
    // the corresponding user rows, like operator_events.user_id.
    invited_by: text('invited_by').notNull(),
    accepted_by: text('accepted_by'),
    revoked_at: timestamp('revoked_at', { mode: 'string' }),
    revoked_by: text('revoked_by'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    accepted_at: timestamp('accepted_at', { mode: 'string' }),
  },
  (table) => [
    index('idx_invitations_email').on(table.email),
    index('idx_invitations_status').on(table.status),
  ],
);
