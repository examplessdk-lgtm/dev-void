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
  headers: [string, string][];
}

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

export interface AssetConfig {
  not_found_handling?: "none" | "single-page-application" | "404-page";
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
}

export interface WebSocketRouteMeta {
  pattern: string;
  filePath: string;
  className: string;
  mode: "room" | "socket";
  hasAuthGate: boolean;
}

export interface WebSocketMigrationMeta {
  tag: string;
  newClasses?: string[];
  deletedClasses?: string[];
}

export interface WebSocketManifestMeta {
  routes: WebSocketRouteMeta[];
  classes: string[];
  migrations?: WebSocketMigrationMeta[];
}

export interface DeployManifest {
  version: number;
  auth?: boolean;
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
    ai?: boolean;
    hyperdrive?: string[];
  };
  migrations?: {
    dialect: "sqlite" | "postgresql";
    pending: number;
  };
  schedules?: ScheduleMeta[];
  queues?: QueueMeta[];
  ssr?: boolean;
  framework?: string;
  type?: "void" | "spa" | "static" | "framework";
  revalidate?: number | Record<string, number>;
  prerender?: string[];
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  hashedAssetsPrefix?: string;
  headerRules?: HeaderRule[];
  redirectRules?: RedirectRule[];
  websocket?: WebSocketManifestMeta;
}

export type DeployEvent =
  | { event: "start"; deploymentId: string }
  | { event: "asset_upload"; total: number; new: number; cached: number }
  | { event: "asset_upload_done" }
  | { event: "provisioning"; bindings: string[] }
  | { event: "provisioning_done" }
  | { event: "migration_start"; pending: number }
  | { event: "migration"; name: string; durationMs: number }
  | { event: "worker_upload"; modules: number }
  | { event: "worker_upload_done" }
  | { event: "queue_setup"; queues: string[] }
  | { event: "prerender"; pages: number }
  | { event: "prerender_done" }
  | {
      event: "done";
      deployment: string;
      url: string;
      urls: string[];
      assets: number;
      workers: number;
      migrations?: number;
    }
  | { event: "error"; message: string; step: string };
