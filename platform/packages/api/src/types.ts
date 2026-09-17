import type { InferSelectModel } from 'drizzle-orm';
import type {
  builds,
  deployments,
  domains,
  emailDestinations,
  githubConnections,
  githubInstallationMembers,
  githubInstallations,
  invitations,
  oauthAccounts,
  platformEvents,
  projectDatabaseCredentials,
  projects,
  projectSecrets,
  resources,
  users,
} from './schema.ts';

export { MANIFEST_REDIRECT_RULE_STATUSES, SUPPORTED_MANIFEST_VERSIONS } from '@void/deploy-core';
export type {
  AssetConfig,
  DeployAppType,
  DeployArtifact,
  DeployCapabilitySupport,
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

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export type User = InferSelectModel<typeof users>;
export type OAuthAccount = InferSelectModel<typeof oauthAccounts>;
export type Project = InferSelectModel<typeof projects>;
export type Deployment = InferSelectModel<typeof deployments>;
export type DeploymentStatus = Deployment['status'];
export type ProjectSecret = InferSelectModel<typeof projectSecrets>;
export type Resource = InferSelectModel<typeof resources>;
export type Domain = InferSelectModel<typeof domains>;
export type EmailDestination = InferSelectModel<typeof emailDestinations>;
export type PlatformEvent = InferSelectModel<typeof platformEvents>;
export type Invitation = InferSelectModel<typeof invitations>;
export type ProjectDatabaseCredentials = InferSelectModel<typeof projectDatabaseCredentials>;
export type Build = InferSelectModel<typeof builds>;
export type GitHubConnection = InferSelectModel<typeof githubConnections>;
export type GitHubInstallation = InferSelectModel<typeof githubInstallations>;
export type GitHubInstallationMember = InferSelectModel<typeof githubInstallationMembers>;
