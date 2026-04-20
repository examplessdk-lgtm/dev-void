export interface MigrationMeta {
  name: string;
  destructive: boolean;
}

export interface ScheduleMeta {
  name: string;
  cron: string;
}

export interface QueueMeta {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
}

export interface HeaderRule {
  pattern: string;
  headers: Array<[string, string]>;
}

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
  /**
   * Netlify-compatible force flag. Only meaningful for `status: 200` rewrites.
   *
   * - `true` (from `200!` in `_redirects` or `routing.rewrites` in void.json) —
   *   fires unconditionally, overriding any matching static asset.
   * - `false` / omitted (from `200` in `_redirects` or `routing.fallbacks` in
   *   void.json) — fires only when the static asset resolver would 404.
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
}

export interface AssetConfig {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
}

export interface WebSocketRouteMeta {
  pattern: string;
  filePath: string;
  className: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
}

export interface WebSocketMigrationMeta {
  tag: string;
  newClasses?: Array<string>;
  deletedClasses?: Array<string>;
}

export interface WebSocketManifestMeta {
  routes: Array<WebSocketRouteMeta>;
  classes: Array<string>;
  migrations?: Array<WebSocketMigrationMeta>;
}

export interface DeployManifest {
  version: number;
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
  };
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  revalidate?: number | Record<string, number>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<RedirectRule>;
  fallbackRules?: Array<RedirectRule>;
  websocket?: WebSocketManifestMeta;
}

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'heartbeat'; deploymentId?: string; step: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: Array<string> }
  | { event: 'provisioning_done' }
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
    }
  | { event: 'error'; message: string; step: string };
