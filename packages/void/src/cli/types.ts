import type { RedirectRule } from '@void/deploy-core';

export type {
  AssetConfig,
  DeployAppType,
  DeployArtifact,
  DeployAssetManifestEntry,
  DeployAssetUploadRequest,
  DeployEvent,
  DeployIntent,
  DeployManifest,
  DeployRuntimeFeatures,
  DeploySourceMetadata,
  DeployTarget,
  DeployTargetAdapter,
  DeployTargetCapabilities,
  DeployCapabilitySupport,
  DeployUploadPayload,
  HeaderRule,
  LiveManifestMeta,
  LiveMigrationMeta,
  MigrationMeta,
  QueueMeta,
  RedirectRule,
  SandboxManifestMeta,
  SandboxMigrationMeta,
  ScheduleMeta,
  WebSocketManifestMeta,
  WebSocketMigrationMeta,
  WebSocketRouteMeta,
} from '@void/deploy-core';

/** CLI- and development-only routing metadata, stripped before serialization. */
export type DevRedirectRule = RedirectRule & {
  force?: boolean;
  origin?: string;
};
