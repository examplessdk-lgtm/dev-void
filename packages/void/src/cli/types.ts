export type MigrationMeta = {
  name: string;
  destructive: boolean;
};

export type ScheduleMeta = {
  name: string;
  cron: string;
};

export type QueueMeta = {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
};

export type HeaderRule = {
  pattern: string;
  headers: Array<[string, string]>;
};

/**
 * Public wire-shape of a redirect / rewrite / fallback rule as shipped in the
 * deploy manifest. Consumers of the public API (e.g. programmatic deploy
 * callers) should use this type.
 *
 * Dev-only / internal fields (`force`, `origin`) live on `DevRedirectRule` so
 * they don't leak into consumer autocomplete. `stripDevOnlyRuleFields` in
 * `cli/package.ts` narrows `DevRedirectRule[]` to `RedirectRule[]` before the
 * manifest is serialised.
 */
export type RedirectRule = {
  source: string;
  destination: string;
  status: number;
  /**
   * Optional literal host the rule is scoped to. Authored as an
   * `https://host/path` prefix on the source in `_redirects` (or as the
   * `host` key in a `routing.redirects` object form in `void.json`); the
   * parser splits the URL and stores `host` here, leaving `source` as the
   * path-only pattern.
   *
   * Lowercase-normalized at parse time. The platform validates that `host`
   * is bound to the project at deploy ingest, and dispatch matches it
   * byte-for-byte against `url.hostname` at request time. Optional —
   * path-only rules apply to every host bound to the project.
   *
   * Source must use `https://`. `http://` and protocol-relative `//` are
   * rejected at parse time (TLS terminates upstream of the worker; only
   * `https://` requests reach the runtime).
   */
  host?: string;
};

/**
 * Internal rule shape — `RedirectRule` plus dev-only metadata used during
 * local development and by the CLI before shipping. This type is not
 * re-exported publicly; consumers should never see `force` or `origin` in
 * their autocomplete.
 */
export type DevRedirectRule = RedirectRule & {
  /**
   * Netlify-compatible force flag. Only meaningful for `status: 200` rewrites.
   *
   * - `true` (from `200!` in `_redirects` or `routing.rewrites` in void.json) —
   *   fires unconditionally, overriding any matching static asset.
   * - `false` / omitted (from `200` in `_redirects` or `routing.fallbacks` in
   *   void.json) — fires only when the static asset resolver would 404.
   *
   * Dev-only / internal flag. The CLI uses `force` to split rules into the
   * `redirectRules` (always) and `fallbackRules` (post-asset) buckets, and
   * the router uses it to label the `X-Void-Routing` trace header on
   * Node/Bun/Deno targets. The deployed platform decides phase purely from
   * which array the rule lives in, so `force` is stripped from each rule
   * before shipping (see `stripDevOnlyRuleFields` in cli/package.ts),
   * mirroring `origin` below.
   */
  force?: boolean;
  /**
   * Dev-only metadata identifying where the rule was declared, used to build
   * the `X-Void-Routing` trace header. Examples: `_redirects:12`,
   * `void.json#routing.rewrites`, `spa-default`.
   *
   * This field is stripped from compiled-in rule tables when the worker is
   * built for production (`CompileOptions.dev !== true`), so it never ships
   * to end users and does not bloat the deployed bundle.
   */
  origin?: string;
};

export type AssetConfig = {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
  run_worker_first?: boolean | Array<string>;
};

export type WebSocketRouteMeta = {
  pattern: string;
  filePath: string;
  className: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
};

export type WebSocketMigrationMeta = {
  tag: string;
  newClasses?: Array<string>;
  deletedClasses?: Array<string>;
};

export type WebSocketManifestMeta = {
  routes: Array<WebSocketRouteMeta>;
  classes: Array<string>;
  migrations?: Array<WebSocketMigrationMeta>;
};

export type SandboxMigrationMeta = {
  tag: string;
  newSqliteClasses?: Array<string>;
  deletedClasses?: Array<string>;
};

export type SandboxManifestMeta = {
  bindingName: string;
  className: string;
  containerName: string;
  image: string;
  instanceType?: string;
  maxInstances?: number;
  migrations?: Array<SandboxMigrationMeta>;
};

export type LiveMigrationMeta = {
  tag: string;
  newSqliteClasses?: Array<string>;
};

export type LiveManifestMeta = {
  bindingName: string;
  className: string;
  storage: 'sqlite';
  classes: Array<string>;
  migrations?: Array<LiveMigrationMeta>;
};

export type DeployManifest = {
  version: number;
  /**
   * Wire-format version of the per-asset entries in the sibling
   * `assetManifest` payload (not this manifest object itself):
   *   - `1` (or omitted): legacy `{ hash, size }` shape.
   *   - `2`: `{ blake3, md5, size, hash? }` shape — required by the
   *     direct-to-R2 deploy path (R2 enforces `Content-MD5` on PUT, so
   *     each asset must declare both hashes up front).
   *
   * The CLI emits `2` going forward. The platform's deploy ingest accepts
   * either shape on the multipart endpoint; the JSON-mode (manifest-only)
   * deploy endpoint requires `2`.
   */
  assetManifestVersion?: 1 | 2;
  auth?: boolean;
  bindings: {
    d1?: Array<string>;
    kv?: Array<string>;
    r2?: Array<string>;
    ai?: boolean;
    hyperdrive?: Array<string>;
  };
  migrations?: {
    dialect: 'sqlite' | 'postgresql';
    pending: number;
    protocolVersion?: 2;
    classifierVersion?: number;
    migrationListHash?: string;
    stability?: 'stable' | 'legacy';
  };
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  /** Ordered page-route table for route-aware ISR resolution (pages mode). */
  pages?: Array<{ pattern: string; revalidate?: number }>;
  /**
   * RAW per-path `void.json` `routing.revalidate` OBJECT config (pages mode).
   * Shipped ALONGSIDE the `pages` table so dispatch can resolve a matched
   * inherit-eligible page (a `pages` entry with NO baked `revalidate`) against
   * the ACTUAL request path — honoring per-path rules and `0` opt-outs that a
   * dynamic page pattern straddles, which build-time baking cannot. Distinct
   * from (and uncontaminated by) the folded `revalidate` map. Object form only:
   * a global-number config is already baked into every `pages` entry.
   */
  pathRevalidate?: Record<string, number>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  /** Worker resource limit overrides from void.json `worker.limits`. */
  limits?: { cpuMs?: number };
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<RedirectRule>;
  fallbackRules?: Array<RedirectRule>;
  websocket?: WebSocketManifestMeta;
  sandbox?: SandboxManifestMeta;
  live?: LiveManifestMeta;
};

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'heartbeat'; deploymentId?: string; step: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: Array<string> }
  | { event: 'provisioning_done' }
  | { event: 'worker_readiness' }
  | { event: 'migration_start'; pending: number }
  | { event: 'migration'; name: string; durationMs: number }
  | { event: 'worker_upload'; modules: number }
  | { event: 'worker_upload_done' }
  | { event: 'queue_setup'; queues: Array<string> }
  | { event: 'queue_consumer_conflict'; queue: string; ownerScript: string }
  | { event: 'prerender'; pages: number }
  | { event: 'prerender_done' }
  | {
      event: 'done';
      deployment: string;
      url: string;
      urls: Array<string>;
      assets: number;
      workers: number;
      migrations?: number;
      // Optional additive field: whether routing KV was published after the
      // go-live DB commit. Omitted by older servers (treated as published).
      // `false` means the deploy is committed-live but its routing was not
      // published — the project may be unreachable or still serving the
      // previous deploy. The CLI degrades its messaging but does NOT treat
      // this as an error: the new model never rolls back a committed deploy.
      published?: boolean;
    }
  | { event: 'error'; message: string; step: string };
