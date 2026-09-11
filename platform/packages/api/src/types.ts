import type { InferSelectModel } from 'drizzle-orm';
import type {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  platformEvents,
  invitations,
  projectMigrations,
  projectDatabaseCredentials,
  builds,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
} from './schema.ts';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export type User = InferSelectModel<typeof users>;
export type OAuthAccount = InferSelectModel<typeof oauthAccounts>;
export type Project = InferSelectModel<typeof projects>;
export type Deployment = InferSelectModel<typeof deployments>;
export type DeploymentStatus = Deployment['status'];
export type ProjectSecret = InferSelectModel<typeof projectSecrets>;
export type Resource = InferSelectModel<typeof resources>;
export type Domain = InferSelectModel<typeof domains>;
export type PlatformEvent = InferSelectModel<typeof platformEvents>;
export type Invitation = InferSelectModel<typeof invitations>;
export type ProjectMigration = InferSelectModel<typeof projectMigrations>;
export type ProjectDatabaseCredentials = InferSelectModel<typeof projectDatabaseCredentials>;
export type Build = InferSelectModel<typeof builds>;
export type GitHubConnection = InferSelectModel<typeof githubConnections>;
export type GitHubInstallation = InferSelectModel<typeof githubInstallations>;
export type GitHubInstallationMember = InferSelectModel<typeof githubInstallationMembers>;
export type GitHubInstallationRevocation = InferSelectModel<typeof githubInstallationRevocations>;

export type MigrationMeta = Readonly<{
  name: string;
  destructive: boolean;
}>;

export type ScheduleMeta = Readonly<{
  name: string;
  cron: string;
}>;

export type QueueMeta = Readonly<{
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}>;

export const SUPPORTED_MANIFEST_VERSIONS = [3];

export type AssetConfig = Readonly<{
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
}>;

export type WebSocketRouteMeta = Readonly<{
  pattern: string;
  filePath: string;
  className: string;
  bindingName?: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
}>;

export type WebSocketMigrationMeta = Readonly<{
  tag: string;
  newClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
}>;

export type WebSocketManifestMeta = Readonly<{
  routes: ReadonlyArray<WebSocketRouteMeta>;
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<WebSocketMigrationMeta>;
}>;

export type SandboxMigrationMeta = Readonly<{
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
}>;

export type SandboxManifestMeta = Readonly<{
  bindingName: string;
  className: string;
  containerName: string;
  image: string;
  instanceType?: string;
  maxInstances?: number;
  migrations?: ReadonlyArray<SandboxMigrationMeta>;
}>;

export type LiveMigrationMeta = Readonly<{
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
}>;

export type LiveManifestMeta = Readonly<{
  bindingName: string;
  className: string;
  storage: 'sqlite';
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<LiveMigrationMeta>;
}>;

/**
 * Manifest header-rule shape. Mirrors `HeaderRule` in `dispatch/src/headers.ts`
 * and the framework-side `HeaderRule` in `packages/void/src/cli/types.ts`.
 * Structural equivalence across the three is pinned by
 * `packages/dispatch/test/unit/framework-contract.test.ts`.
 */
export type HeaderRule = Readonly<{
  pattern: string;
  headers: ReadonlyArray<[string, string]>;
}>;

/**
 * Manifest redirect/rewrite rule shape. Mirrors `RedirectRule` in
 * `dispatch/src/routing-rules.ts` and the framework-side `RedirectRule` in
 * `packages/void/src/cli/types.ts`. Structural equivalence across the three
 * is pinned by `packages/dispatch/test/unit/framework-contract.test.ts`.
 */
export type RedirectRule = Readonly<{
  source: string;
  destination: string;
  status: number;
  /**
   * Optional literal host the rule is scoped to. Authored as an
   * `https://host/path` prefix on the source in `_redirects` (or as the
   * `host` key in a `routing.redirects` object form in `void.json`); the
   * framework parser splits the URL and stores `host` here, leaving
   * `source` as the path-only pattern. Lowercase-normalized at parse time.
   * The platform validates that `host` is bound to the project at deploy
   * ingest, and dispatch matches it byte-for-byte against `url.hostname`
   * at request time. Optional — path-only rules apply to every host bound
   * to the project.
   */
  host?: string;
}>;

/**
 * Statuses accepted on manifest `redirectRules` entries at ingest:
 * 200 for pre-asset "force" rewrites, 3xx for redirects. Superset of the
 * SDK's `VALID_REDIRECT_STATUSES` (`packages/void/src/config.ts`) —
 * the 200 case is encoded by which array the rule lives in, not a separate
 * wire field. Keep in sync with the SDK's 3xx list on HTTP-spec
 * changes; a runtime cross-package import isn't viable because the SDK's
 * `config.ts` pulls `node:fs` / `node:path`, which don't resolve against
 * dispatch's `@cloudflare/workers-types`-only tsconfig.
 */
export const MANIFEST_REDIRECT_RULE_STATUSES: ReadonlySet<number> = new Set([
  200, 301, 302, 303, 307, 308,
]);

export type DeployManifest = Readonly<{
  version: number;
  /**
   * Asset manifest schema version. Absent / 1 = legacy
   * `Record<path, { hash, size }>` (multipart deploys). 2 = direct-to-R2
   * upload flow (`Record<path, { blake3, md5, size }>`); JSON-mode deploys
   * must declare `assetManifestVersion === 2`. See
   * `meta/design-docs/0068-direct-r2-asset-upload.md`.
   */
  assetManifestVersion?: 1 | 2;
  auth?: boolean;
  bindings: {
    d1?: ReadonlyArray<string>;
    kv?: ReadonlyArray<string>;
    r2?: ReadonlyArray<string>;
    ai?: boolean;
    hyperdrive?: ReadonlyArray<string>;
  };
  migrations?: {
    dialect: 'sqlite' | 'postgresql' | 'mysql';
    pending: number;
    protocolVersion?: 2;
    classifierVersion?: number;
    migrationListHash?: string;
    stability?: 'stable' | 'legacy';
  };
  schedules?: ReadonlyArray<ScheduleMeta>;
  queues?: ReadonlyArray<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  revalidate?: number | Record<string, number>;
  /**
   * Per-pathname allowlist of query params that participate in the ISR
   * variant key on a rewrite. Default (no entry / no allowlist) drops
   * every param so an attacker can't fan out cache slots by varying
   * `?utm`/`?cb`/etc. Path patterns are matched against the user-facing
   * (pre-rewrite) pathname; first match wins. A `*` entry acts as a
   * catch-all default.
   */
  revalidateQueryAllowlist?: Record<string, ReadonlyArray<string>>;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  /**
   * RAW per-path `void.json` `routing.revalidate` OBJECT config (pages mode),
   * shipped alongside `pages` so dispatch can resolve an inherit-eligible page
   * (a `pages` entry with no baked `revalidate`) against the actual request
   * path — honoring per-path rules and `0` opt-outs a dynamic pattern straddles.
   */
  pathRevalidate?: Record<string, number>;
  prerender?: ReadonlyArray<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: ReadonlyArray<string>;
  /**
   * Per-project worker limit overrides (void.json `worker.limits`, snake_case
   * `cpu_ms` on the config surface — camelCase here like other manifest
   * fields). Ingest rejects a `cpuMs` above the plan's `maxCpuMsPerRequest`;
   * rollback clamps instead (see `computeDispatchLimits`).
   */
  limits?: Readonly<{ cpuMs?: number }>;
  hashedAssetsPrefix?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  websocket?: WebSocketManifestMeta;
  sandbox?: SandboxManifestMeta;
  live?: LiveManifestMeta;
}>;

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'heartbeat'; deploymentId?: string; step: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: ReadonlyArray<string> }
  | { event: 'provisioning_done' }
  | { event: 'worker_readiness' }
  | { event: 'migration_start'; pending: number }
  | { event: 'migration'; name: string; durationMs: number; stability?: 'stable' | 'legacy' }
  | { event: 'migration_warning'; message: string }
  | { event: 'worker_upload'; modules: number }
  | { event: 'worker_upload_done' }
  | { event: 'queue_setup'; queues: ReadonlyArray<string> }
  | { event: 'queue_consumer_conflict'; queue: string; ownerScript: string }
  | { event: 'prerender'; pages: number }
  | { event: 'prerender_done' }
  | {
      event: 'done';
      deployment: string;
      url: string;
      urls: ReadonlyArray<string>;
      assets: number;
      workers: number;
      migrations?: number;
    }
  | { event: 'error'; message: string; step: string };
