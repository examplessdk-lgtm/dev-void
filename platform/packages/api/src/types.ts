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
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  projectZeroTrust,
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
export type InvitationEmailDeliveryStatus = 'sent' | 'failed' | 'unavailable';
export type ProjectMemberRole = 'reader' | 'collaborator' | 'admin';
export type ProjectRole = ProjectMemberRole | 'owner';
export type ProjectCapability = 'read' | 'deploy' | 'configure' | 'settings' | 'members' | 'delete';
export type ProjectInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
export type ProjectAccessEventAction =
  | 'invited'
  | 'invitation_resent'
  | 'member_added'
  | 'accepted'
  | 'declined'
  | 'invitation_revoked'
  | 'role_changed'
  | 'member_removed'
  | 'left';

export type User = InferSelectModel<typeof users>;
export type OAuthAccount = InferSelectModel<typeof oauthAccounts>;
export type Project = InferSelectModel<typeof projects>;
export type ProjectMember = InferSelectModel<typeof projectMembers>;
export type ProjectInvitation = InferSelectModel<typeof projectInvitations>;
export type ProjectOwnershipPeriod = InferSelectModel<typeof projectOwnershipPeriods>;
export type ProjectZeroTrust = InferSelectModel<typeof projectZeroTrust>;
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
