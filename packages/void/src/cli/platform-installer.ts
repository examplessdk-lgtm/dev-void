import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  readCloudflareVersionMigrationTag,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
  type CloudflareCommandRunner,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  createPlatformWorkerConfigs,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  PLATFORM_SANDBOX_DRAIN_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
  parsePlatformAuthenticationSetup,
  parsePlatformAccessProtection,
  type PlatformAccessProtection,
  type PlatformLoginKind,
} from '@void/platform';
import {
  PLATFORM_ADMIN_ASSETS_DIRECTORY,
  platformDatabaseSchemaDigest,
  resolvePlatformRuntime,
} from '@void/platform/installer';
import type {
  PlatformRuntime,
  PlatformRuntimeDatabaseManifest,
  PlatformRuntimeManifest,
  PlatformRuntimeMigration,
} from '@void/platform/installer';
import { dirname, join, resolve } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { verifyInstalledPlatformAccessProtection } from './platform-access-preflight.ts';
import {
  activatePlatformAccessCredentials,
  checkpointPlatformAccessResources,
  isPlatformAuthenticationPreparationKey,
} from './platform-access-setup.ts';
import {
  initializeInstalledPlatformAuthentication,
  resumeInstalledPlatformAuthentication,
} from './platform-auth-bootstrap.ts';
import {
  verifyExternalPlatformHyperdrive,
  verifyPlatformAuthenticationDatabase,
} from './platform-auth-database.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  parsePostgresConnectionString,
  PlatformWorkerCustomDomainsChangedError,
  PlatformWorkerRoutesChangedError,
  type CloudflareNamedResource,
  type CloudflareWorkerCustomDomainOrigin,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import {
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
  type PlatformInstallPlan,
  type PlatformInstallPlanAction,
} from './platform-plan.ts';
import {
  latestPlatformWorkerCutoverGeneration,
  platformWorkerSecretUpdateIntentState,
  promoteInstallationSecrets,
  readPendingInstallationSecrets,
  savePlatformConnection,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import { assertPlatformWorkerSecretUpdateAuthority } from './platform-secret-update-authority.ts';
import {
  platformManagedWorkerTraffic,
  recordPlatformWorkerTraffic,
  trackedPlatformWorkerTraffic,
} from './platform-traffic.ts';
import { platformWorkerLiveTriggersMatch } from './platform-trigger-proof.ts';
import { resolveWranglerArgv } from './preset.ts';
import { createDefaultRunWrangler, resolvePinnedApiBaseUrl } from './provision.ts';

export const REMOTE_INSTALLATION_MANIFEST_KEY: string = PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY;

export type PlatformInstallationSecrets = Readonly<{
  authenticationPreparation?: Readonly<Record<string, string>>;
  accessProvisioningJson?: string;
  accessCredentialsJson?: string;
  authenticationSetupJson?: string;
  authSetupToken?: string;
  authBootstrapCode?: string;
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  emailEnabled: boolean;
  emailSigningSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  jwtSecret: string;
  projectSecretActiveKeyVersion: string;
  projectSecretKey: string;
  projectSecretKeysJson: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  /** Explicitly authorized updates; recovered email identity remains authoritative. */
  workerSecretUpdates?: Readonly<
    Partial<
      Record<
        | 'CF_API_TOKEN'
        | 'EMAIL_SIGNING_SECRET'
        | 'GITHUB_CLIENT_ID'
        | 'GITHUB_CLIENT_SECRET'
        | 'R2_ACCESS_KEY_ID'
        | 'R2_SECRET_ACCESS_KEY',
        string
      >
    >
  >;
  /** Encrypted recovery intent; applied only while its Worker cutover is authoritative. */
  pendingWorkerSecretUpdateIntent?: PlatformWorkerSecretUpdateIntent;
}>;

const PLATFORM_WORKER_SECRET_UPDATE_NAMES = [
  'CF_API_TOKEN',
  'EMAIL_SIGNING_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

type PlatformWorkerSecretUpdateName = (typeof PLATFORM_WORKER_SECRET_UPDATE_NAMES)[number];

type PlatformWorkerSecretUpdates = Partial<Record<PlatformWorkerSecretUpdateName, string>>;

type PlatformWorkerSecretUpdateIntent = Readonly<{
  baselineGeneration: number;
  generation: number | null;
  id: string;
  schema: 1;
  updates: Readonly<PlatformWorkerSecretUpdates>;
}>;

export type PlatformDatabaseLifecycleLock = (() => Promise<void>) & {
  readAuthenticationState?: () => Promise<{
    enabledProviders: ReadonlyArray<PlatformLoginKind>;
    sessionsRequired: boolean;
    protectedByAccess: boolean;
    protection?: PlatformAccessProtection | null;
  } | null>;
  authoritativeManifest?: PlatformInstallationManifest | null;
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
  prepareSandboxDrain?: (
    requiredAdmissionProtocol?: 0 | 2 | 3,
  ) => Promise<PlatformSandboxDrainPreparation>;
  requiredSafetyProtocols?: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>;
  verifyDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
  ) => Promise<void>;
};

type PlatformLiveAuthenticationState = NonNullable<
  Awaited<ReturnType<NonNullable<PlatformDatabaseLifecycleLock['readAuthenticationState']>>>
>;

/** Preserve database-authoritative authentication choices while upgrading old manifests. */
export function mergePlatformLiveAuthenticationDeployment(
  deployment: PlatformInstallationManifest['deployment'],
  live: PlatformLiveAuthenticationState,
): PlatformInstallationManifest['deployment'] {
  const providers =
    live.enabledProviders.length > 0 ? live.enabledProviders : deployment.authentication.providers;
  return createPlatformDeploymentManifest({
    ...deployment,
    authentication: {
      providers,
      ...(live.sessionsRequired ? { configurable: true as const } : {}),
      ...(live.protectedByAccess ? { accessProtection: true as const } : {}),
    },
    capabilities: {
      ...deployment.capabilities,
      githubOAuth: providers.includes('github'),
      googleOAuth: providers.includes('google'),
    },
  });
}

export type PlatformDatabaseState = Readonly<{
  pendingMigrations: ReadonlyArray<PlatformRuntimeMigration>;
  schemaDigest: string;
}>;

export type PlatformSandboxDrainPreparation = Readonly<{
  admissionProtocol: 0 | 2 | 3;
  generation: string;
  mirrorValue: string;
  state: 'complete' | 'pending';
}>;

export type PlatformDatabaseMigrationResult = Readonly<{
  appliedMigrations: number;
  previousSchemaDigest: string;
  schemaDigest: string;
}>;

type InstallerClient = Pick<
  PlatformCloudflareClient,
  | 'createDispatchNamespace'
  | 'createDnsRecord'
  | 'createAiGateway'
  | 'createHyperdrive'
  | 'getHyperdriveConfig'
  | 'disableHyperdriveCaching'
  | 'createKvNamespace'
  | 'createQueue'
  | 'createR2Bucket'
  | 'createZone'
  | 'putKvValue'
  | 'putR2Object'
> &
  Partial<
    Pick<
      PlatformCloudflareClient,
      | 'request'
      | 'apiBaseUrl'
      | 'deleteKvValue'
      | 'getWorkerPlainTextBindings'
      | 'listWorkerDomains'
      | 'listWorkerNames'
      | 'listWorkerServiceRoutes'
      | 'listWorkerRoutes'
      | 'publishWorkerCustomDomainsSafely'
      | 'publishWorkerRoutesSafely'
      | 'removeRoutes'
    >
  > & { readonly apiBaseUrl?: string };

type WorkerInspectionClient = Partial<
  Pick<PlatformCloudflareClient, 'getWorkerPlainTextBindings' | 'listWorkerNames'>
>;

type PlatformWorkerRollback = () => Promise<void>;

export class PlatformWorkerRecoveryIncompleteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerRecoveryIncompleteError';
  }
}

export type PlatformInstallerDependencies = Readonly<{
  prepareAuthentication?: (
    manifest: PlatformInstallationManifest,
    secrets: PlatformInstallationSecrets,
  ) => Promise<
    Partial<
      Pick<
        PlatformInstallationSecrets,
        | 'authenticationSetupJson'
        | 'authSetupToken'
        | 'authBootstrapCode'
        | 'accessProvisioningJson'
        | 'accessCredentialsJson'
      >
    >
  >;
  initializeAuthentication?: typeof initializeInstalledPlatformAuthentication;
  verifyAccessProtection?: typeof verifyInstalledPlatformAccessProtection;
  acquireDatabaseLifecycleLock: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<PlatformDatabaseLifecycleLock>;
  claimDatabase?: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<void>;
  client: InstallerClient;
  databaseRollbackSource?: PlatformRuntime;
  deployWorker?: (
    config: Record<string, unknown>,
    secrets: Record<string, string> | null,
    previousConfig: Record<string, unknown>,
  ) => Promise<PlatformWorkerRollback | void>;
  migrateDatabase?: (databaseUrl: string, migrationsFolder: string) => Promise<void>;
  now?: () => string;
  onProgress?: (message: string) => void;
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
  prepareSandboxDrain?: (
    requiredAdmissionProtocol?: 0 | 2 | 3,
  ) => Promise<PlatformSandboxDrainPreparation>;
  recoverWorkerCutover?: (input: {
    key: PlatformWorkerKey;
    preserveCustomDomains: boolean;
    previousVersionId: string | null;
    stagedVersionId: string;
    workerName: string;
  }) => Promise<void>;
  replanWorkers?: (
    manifest: PlatformInstallationManifest,
  ) => Promise<ReadonlyArray<PlatformInstallPlanAction>>;
  revalidateBeforeWorkerDeploy: (
    manifest: PlatformInstallationManifest,
    action: PlatformInstallPlanAction,
  ) => Promise<void>;
  runtime?: PlatformRuntime;
  verifyExistingOwnership?: (
    manifest: PlatformInstallationManifest,
    databaseCheckpointExists: boolean,
  ) => Promise<void>;
  healthCheckResumeCommand?: string;
  bootstrapEmail?: typeof bootstrapPlatformSharedEmail;
  verifyHealth?: typeof verifyPlatformHealth;
  verifySandboxDrain?: (apiUrl: string, healthProbeToken: string) => Promise<boolean>;
  verifyWorkerCutover?: (
    manifest: PlatformInstallationManifest,
    generation: number,
  ) => Promise<void>;
}>;

export type PlatformInstallationResult = Readonly<{
  emailOperationId?: string;
  manifest: PlatformInstallationManifest;
  setupPending?: boolean;
  waitingForDns: boolean;
  waitingForSandboxDrain: boolean;
  zoneNameServers: ReadonlyArray<string>;
}>;

export function loadPlatformRuntime(customRuntimeDirectory: string): PlatformRuntime {
  const runtime = resolvePlatformRuntime(customRuntimeDirectory || undefined);
  verifyRuntimeArtifacts(runtime.directory, runtime.manifest);
  return runtime;
}

export function createPlatformInstallationSecrets(input: {
  configurableAuthentication?: boolean;
  authenticationSetupJson?: string;
  authSetupToken?: string;
  authBootstrapCode?: string;
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  emailEnabled?: boolean;
  emailSigningSecret?: string;
  existingEmailEnabled?: boolean;
  githubClientId: string;
  githubClientSecret: string;
  existingInstallation?: boolean;
  /** The caller supplies current explicit rotation inputs, not resumed inputs. */
  updateExistingWorkers?: boolean;
  jwtSecret?: string;
  projectSecretActiveKeyVersion?: string;
  projectSecretKey?: string;
  projectSecretKeysJson?: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  checkpoint?: Record<string, string> | null;
}): PlatformInstallationSecrets {
  const checkpoint = input.checkpoint ?? {};
  const required = (value: string, name: string): string => {
    if (!value) {
      throw new Error(`platform: ${name} is required to install the platform.`);
    }
    return value;
  };
  // Runtime signing/encryption keys are installation identity, not ordinary
  // configuration. A checkpoint wins over the legacy single-key inputs. The
  // explicit complete-keyring pair is the only supported way to supersede a
  // stale encryption checkpoint, and existing Workers still inherit live keys.
  const existingInstallation = input.existingInstallation === true;
  const restoredIdentity = (explicit: string, name: string): string =>
    existingInstallation ? checkpoint[name] || explicit || '' : explicit || checkpoint[name] || '';
  const configured = (explicit: string, name: string): string => explicit || checkpoint[name] || '';
  const authenticationSetupJson = configured(
    input.authenticationSetupJson ?? '',
    'authenticationSetupJson',
  );
  const authSetupToken = configured(input.authSetupToken ?? '', 'authSetupToken');
  const authBootstrapCode = configured(input.authBootstrapCode ?? '', 'authBootstrapCode');
  const modernAuthentication =
    input.configurableAuthentication === true || !!authenticationSetupJson;
  if (
    modernAuthentication &&
    !existingInstallation &&
    (authSetupToken.length < 32 || !/^[a-f0-9]{64}$/.test(authBootstrapCode))
  ) {
    throw new Error(
      'platform: Valid setup authority and an administrator setup code are required.',
    );
  }
  if (authenticationSetupJson) {
    const setup = parsePlatformAuthenticationSetup(JSON.parse(authenticationSetupJson));
    if (
      !existingInstallation &&
      (authSetupToken.length < 32 ||
        !/^[a-f0-9]{64}$/.test(authBootstrapCode) ||
        createHash('sha256').update(authBootstrapCode).digest('hex') !==
          setup.bootstrapCredentialHash)
    ) {
      throw new Error(
        'platform: Valid installation setup authority and a matching administrator setup code are required.',
      );
    }
  }
  const jwtSecret = restoredIdentity(input.jwtSecret || '', 'jwtSecret');
  const resolvedJwtSecret = input.existingInstallation
    ? jwtSecret
    : required(jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
  if (!existingInstallation && Buffer.byteLength(resolvedJwtSecret, 'utf8') < 32) {
    throw new Error(
      'platform: VOID_PLATFORM_JWT_SECRET must contain at least 32 bytes of secret material unique to this installation.',
    );
  }
  const emailEnabled = input.emailEnabled === true;
  const existingEmailEnabled = input.existingEmailEnabled === true;
  const emailSigningSecretInScope = emailEnabled || existingEmailEnabled;
  let emailSigningSecret = emailSigningSecretInScope
    ? restoredIdentity(input.emailSigningSecret || '', 'emailSigningSecret')
    : checkpoint.emailSigningSecret || '';
  if (emailEnabled && !emailSigningSecret) {
    if (existingInstallation && existingEmailEnabled) {
      throw new Error(
        'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET is required to maintain an email-enabled installation without its encrypted recovery state.',
      );
    }
    emailSigningSecret = randomBytes(32).toString('base64');
  }
  if (
    emailSigningSecretInScope &&
    emailSigningSecret &&
    Buffer.byteLength(emailSigningSecret, 'utf8') < 32
  ) {
    throw new Error(
      'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET must contain at least 32 bytes of secret material unique to this installation.',
    );
  }
  if (emailSigningSecretInScope && emailSigningSecret && emailSigningSecret === resolvedJwtSecret) {
    throw new Error(
      'platform: VOID_PLATFORM_EMAIL_SIGNING_SECRET must be different from VOID_PLATFORM_JWT_SECRET.',
    );
  }
  const projectSecretKeyring = resolveProjectSecretKeyring({
    checkpoint,
    existingInstallation,
    projectSecretActiveKeyVersion: input.projectSecretActiveKeyVersion || '',
    projectSecretKey: input.projectSecretKey || '',
    projectSecretKeysJson: input.projectSecretKeysJson || '',
    required,
  });
  const pendingWorkerSecretUpdateIntent = parseWorkerSecretUpdateIntent(
    checkpoint.workerSecretUpdatesJson,
  );
  const emailSigningSecretUpdateAuthorized =
    emailSigningSecretInScope &&
    !!emailSigningSecret &&
    ((emailEnabled && (!existingEmailEnabled || !checkpoint.emailSigningSecret)) ||
      !!input.emailSigningSecret);
  const explicitWorkerSecretUpdates = withoutEmptySecrets({
    CF_API_TOKEN: input.cloudflareApiToken,
    ...(emailSigningSecretUpdateAuthorized ? { EMAIL_SIGNING_SECRET: emailSigningSecret } : {}),
    GITHUB_CLIENT_ID: input.githubClientId,
    GITHUB_CLIENT_SECRET: input.githubClientSecret,
    R2_ACCESS_KEY_ID: input.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: input.r2SecretAccessKey,
  });
  return {
    authenticationPreparation: Object.fromEntries(
      Object.entries(checkpoint).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
    ),
    ...(modernAuthentication ? { authenticationSetupJson, authSetupToken, authBootstrapCode } : {}),
    ...(checkpoint.accessProvisioningJson
      ? { accessProvisioningJson: checkpoint.accessProvisioningJson }
      : {}),
    ...(checkpoint.accessCredentialsJson
      ? { accessCredentialsJson: checkpoint.accessCredentialsJson }
      : {}),
    workerSecretUpdates: input.updateExistingWorkers ? explicitWorkerSecretUpdates : {},
    pendingWorkerSecretUpdateIntent: input.updateExistingWorkers
      ? pendingWorkerSecretUpdateIntent
      : undefined,
    bootstrapGitHubId:
      existingInstallation || modernAuthentication
        ? configured(input.bootstrapGitHubId, 'bootstrapGitHubId')
        : required(
            configured(input.bootstrapGitHubId, 'bootstrapGitHubId'),
            'resolved administrator GitHub account id',
          ),
    bootstrapGitHubLogin:
      existingInstallation || modernAuthentication
        ? configured(input.bootstrapGitHubLogin, 'bootstrapGitHubLogin')
        : required(
            configured(input.bootstrapGitHubLogin, 'bootstrapGitHubLogin'),
            'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
          ),
    cloudflareApiToken: existingInstallation
      ? configured(input.cloudflareApiToken, 'cloudflareApiToken')
      : required(
          configured(input.cloudflareApiToken, 'cloudflareApiToken'),
          'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN',
        ),
    databaseUrl: required(input.databaseUrl || checkpoint.databaseUrl || '', 'DATABASE_URL'),
    emailEnabled,
    emailSigningSecret,
    githubClientId:
      existingInstallation || modernAuthentication
        ? configured(input.githubClientId, 'githubClientId')
        : required(
            configured(input.githubClientId, 'githubClientId'),
            'VOID_PLATFORM_GITHUB_CLIENT_ID',
          ),
    githubClientSecret:
      existingInstallation || modernAuthentication
        ? configured(input.githubClientSecret, 'githubClientSecret')
        : required(
            configured(input.githubClientSecret, 'githubClientSecret'),
            'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
          ),
    jwtSecret: resolvedJwtSecret,
    projectSecretActiveKeyVersion: projectSecretKeyring.activeVersion,
    projectSecretKey: projectSecretKeyring.v1Key,
    projectSecretKeysJson: projectSecretKeyring.keysJson,
    r2AccessKeyId: existingInstallation
      ? configured(input.r2AccessKeyId, 'r2AccessKeyId')
      : required(
          configured(input.r2AccessKeyId, 'r2AccessKeyId'),
          'VOID_PLATFORM_R2_ACCESS_KEY_ID',
        ),
    r2SecretAccessKey: existingInstallation
      ? configured(input.r2SecretAccessKey, 'r2SecretAccessKey')
      : required(
          configured(input.r2SecretAccessKey, 'r2SecretAccessKey'),
          'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
        ),
  };
}

function resolveProjectSecretKeyring(input: {
  checkpoint: Record<string, string>;
  existingInstallation: boolean;
  projectSecretActiveKeyVersion: string;
  projectSecretKey: string;
  projectSecretKeysJson: string;
  required: (value: string, name: string) => string;
}): Readonly<{ activeVersion: string; keysJson: string; v1Key: string }> {
  const explicitFullKeyring =
    input.projectSecretKeysJson !== '' || input.projectSecretActiveKeyVersion !== '';
  if (
    explicitFullKeyring &&
    (!input.projectSecretKeysJson || !input.projectSecretActiveKeyVersion)
  ) {
    throw new Error(
      'platform: VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON and VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION must be supplied together.',
    );
  }
  if (explicitFullKeyring && !input.existingInstallation) {
    throw new Error(
      'platform: Fresh installations use VOID_PLATFORM_PROJECT_SECRET_KEY to initialize key version v1. The full project-secret keyring inputs are for restoring an existing installation.',
    );
  }

  const checkpointKeysJson = input.checkpoint.projectSecretKeysJson || '';
  const checkpointActiveVersion = input.checkpoint.projectSecretActiveKeyVersion || '';
  if (
    !explicitFullKeyring &&
    (checkpointKeysJson !== '' || checkpointActiveVersion !== '') &&
    (!checkpointKeysJson || !checkpointActiveVersion)
  ) {
    throw new Error(
      'platform: Encrypted recovery material must contain both the project-secret keyring and its active version.',
    );
  }

  if (explicitFullKeyring) {
    return normalizeProjectSecretKeyring(
      input.projectSecretKeysJson,
      input.projectSecretActiveKeyVersion,
      'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON',
      'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION',
    );
  }
  if (checkpointKeysJson) {
    return normalizeProjectSecretKeyring(
      checkpointKeysJson,
      checkpointActiveVersion,
      'encrypted recovery project-secret keyring',
      'encrypted recovery project-secret active version',
    );
  }

  const v1Key = input.existingInstallation
    ? input.checkpoint.projectSecretKey || input.projectSecretKey || ''
    : input.required(
        input.projectSecretKey || input.checkpoint.projectSecretKey || '',
        'VOID_PLATFORM_PROJECT_SECRET_KEY',
      );
  if (!v1Key) {
    return { activeVersion: '', keysJson: '', v1Key: '' };
  }
  assertCanonicalProjectSecretKey(v1Key, 'VOID_PLATFORM_PROJECT_SECRET_KEY', true);
  return {
    activeVersion: 'v1',
    keysJson: JSON.stringify({ v1: v1Key }),
    v1Key,
  };
}

function normalizeProjectSecretKeyring(
  keysJson: string,
  activeVersion: string,
  keysName: string,
  activeVersionName: string,
): Readonly<{ activeVersion: string; keysJson: string; v1Key: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error(`platform: ${keysName} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`platform: ${keysName} must be a JSON object.`);
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error(`platform: ${keysName} must define at least one key.`);
  }
  for (const [version, key] of entries) {
    if (!version || typeof key !== 'string' || !key) {
      throw new Error(`platform: ${keysName} must map non-empty versions to keys.`);
    }
    assertCanonicalProjectSecretKey(key, `${keysName} entry ${JSON.stringify(version)}`);
  }
  if (!Object.hasOwn(parsed, activeVersion)) {
    throw new Error(`platform: ${activeVersionName} must identify a key in ${keysName}.`);
  }
  const keys = Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>;
  return {
    activeVersion,
    keysJson: JSON.stringify(keys),
    v1Key: keys.v1 || '',
  };
}

function assertCanonicalProjectSecretKey(
  value: string,
  name: string,
  uniqueToInstallation = false,
): void {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    throw new Error(
      `platform: ${name} must be the canonical base64 encoding of a 32-byte key${uniqueToInstallation ? ' unique to this installation' : ''}.`,
    );
  }
}

function secretCheckpoint(
  secrets: PlatformInstallationSecrets,
  workerSecretUpdateIntent?: PlatformWorkerSecretUpdateIntent | null,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(secrets.authenticationPreparation ?? {}).filter(([name]) =>
        isPlatformAuthenticationPreparationKey(name),
      ),
    ),
    ...(secrets.authSetupToken
      ? {
          authenticationSetupJson: secrets.authenticationSetupJson ?? '',
          authSetupToken: secrets.authSetupToken ?? '',
          authBootstrapCode: secrets.authBootstrapCode ?? '',
        }
      : {}),
    ...(secrets.accessProvisioningJson
      ? { accessProvisioningJson: secrets.accessProvisioningJson }
      : {}),
    ...(secrets.accessCredentialsJson
      ? { accessCredentialsJson: secrets.accessCredentialsJson }
      : {}),
    bootstrapGitHubId: secrets.bootstrapGitHubId,
    bootstrapGitHubLogin: secrets.bootstrapGitHubLogin,
    cloudflareApiToken: secrets.cloudflareApiToken,
    databaseUrl: secrets.databaseUrl,
    githubClientId: secrets.githubClientId,
    githubClientSecret: secrets.githubClientSecret,
    jwtSecret: secrets.jwtSecret,
    emailSigningSecret: secrets.emailSigningSecret,
    projectSecretActiveKeyVersion: secrets.projectSecretActiveKeyVersion,
    projectSecretKey: secrets.projectSecretKey,
    projectSecretKeysJson: secrets.projectSecretKeysJson,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2SecretAccessKey: secrets.r2SecretAccessKey,
    ...(workerSecretUpdateIntent
      ? { workerSecretUpdatesJson: JSON.stringify(workerSecretUpdateIntent) }
      : {}),
  };
}

function parseWorkerSecretUpdateIntent(
  value: string | undefined,
): PlatformWorkerSecretUpdateIntent | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('platform: Encrypted pending Worker secret updates must be valid JSON.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('schema' in parsed) ||
    parsed.schema !== 1 ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    parsed.id === '' ||
    !('baselineGeneration' in parsed) ||
    !Number.isSafeInteger(parsed.baselineGeneration) ||
    Number(parsed.baselineGeneration) < 0 ||
    !('generation' in parsed) ||
    (parsed.generation !== null &&
      (!Number.isSafeInteger(parsed.generation) || Number(parsed.generation) <= 0)) ||
    !('updates' in parsed) ||
    !parsed.updates ||
    typeof parsed.updates !== 'object' ||
    Array.isArray(parsed.updates)
  ) {
    throw new Error('platform: Encrypted pending Worker secret update intent is invalid.');
  }
  const updates: Partial<Record<PlatformWorkerSecretUpdateName, string>> = {};
  for (const [name, entry] of Object.entries(parsed.updates)) {
    if (
      !PLATFORM_WORKER_SECRET_UPDATE_NAMES.includes(name as PlatformWorkerSecretUpdateName) ||
      typeof entry !== 'string' ||
      entry === ''
    ) {
      throw new Error('platform: Encrypted pending Worker secret updates are invalid.');
    }
    updates[name as PlatformWorkerSecretUpdateName] = entry;
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('platform: Encrypted pending Worker secret update intent is empty.');
  }
  return {
    baselineGeneration: Number(parsed.baselineGeneration),
    generation: parsed.generation === null ? null : Number(parsed.generation),
    id: parsed.id,
    schema: 1,
    updates,
  };
}

function sanitizeWorkerSecretUpdates(
  updates: PlatformInstallationSecrets['workerSecretUpdates'],
): PlatformWorkerSecretUpdates {
  return Object.fromEntries(
    Object.entries(updates ?? {}).filter(
      ([name, value]) =>
        PLATFORM_WORKER_SECRET_UPDATE_NAMES.includes(name as PlatformWorkerSecretUpdateName) &&
        typeof value === 'string' &&
        value !== '',
    ),
  );
}

type InstallationCheckpointWriter = (
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
) => Promise<void>;

// Keep the outer installer's failure handler on the latest manifest even when a
// remote create or checkpoint throws partway through this phase.
async function reconcilePlatformInstallationResources(
  manifest: PlatformInstallationManifest,
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  zoneId: string,
  externalHyperdriveOriginHash: string | undefined,
  dependencies: PlatformInstallerDependencies,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<PlatformInstallationManifest> {
  for (const action of plan.actions.filter(
    (entry) => entry.key !== 'routing-kv' && entry.kind !== 'zone' && entry.kind !== 'worker',
  )) {
    const retainedManifest = retainReplacedInstallationResource(manifest, action, now());
    if (retainedManifest !== manifest) {
      manifest = retainedManifest;
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    if (action.action === 'adopt') {
      if (!action.id) {
        throw new Error(`platform: Adopted ${action.kind} ${action.name} has no id.`);
      }
      manifest = recordAdoptionIntent(manifest, action, action.id, now());
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      manifest = recordResource(
        manifest,
        action,
        action.id,
        'adopted',
        now(),
        secrets.databaseUrl,
        action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : undefined,
      );
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      continue;
    }
    if (action.action === 'reuse') {
      if (
        action.id &&
        (action.kind === 'hyperdrive' ||
          !manifest.resources.some((resource) => resource.key === action.key))
      ) {
        manifest = recordResource(
          manifest,
          action,
          action.id,
          undefined,
          now(),
          secrets.databaseUrl,
          action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : undefined,
        );
        onManifestChange(manifest);
        writeInstallationManifest(manifest);
        await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      }
      continue;
    }
    manifest = recordProvisionIntent(manifest, action, now());
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    const resource = await createResource(
      dependencies.client,
      plan,
      action,
      secrets.databaseUrl,
      zoneId,
    );
    manifest = recordResource(
      manifest,
      action,
      resource.id,
      'created',
      now(),
      secrets.databaseUrl,
      action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : resource.fingerprint,
    );
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  }

  return manifest;
}

// Migration checkpoints must likewise be visible to the outer failure handler.
async function preparePlatformDatabaseSchema(
  manifest: PlatformInstallationManifest,
  runtime: PlatformRuntimeManifest,
  runtimeDirectory: string,
  sourcePlatformVersion: string | null,
  hadPriorWorkers: boolean,
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  dependencies: PlatformInstallerDependencies,
  releaseDatabaseLock: PlatformDatabaseLifecycleLock,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<PlatformInstallationManifest> {
  dependencies.onProgress?.('Checking the platform database schema');
  const rollbackDatabase = dependencies.databaseRollbackSource;
  const migrationStep = `database-schema:${runtime.database.schemaDigest}`;
  if (rollbackDatabase) {
    const verifyDatabase = releaseDatabaseLock.verifyDatabase;
    if (!verifyDatabase) {
      throw new Error(
        'platform: The PostgreSQL lifecycle lock cannot verify the forward-only rollback schema.',
      );
    }
    await verifyDatabase(rollbackDatabase.directory, rollbackDatabase.manifest.database);
    manifest = {
      ...manifest,
      databaseSchemaDigest: rollbackDatabase.manifest.database.schemaDigest,
      updatedAt: now(),
    };
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  } else if (!manifest.steps.some((step) => step.key === migrationStep)) {
    dependencies.onProgress?.('Applying platform database migrations');
    const legacyMigrationStep = `database-migrations:${runtime.database.journalSha256}`;
    if (dependencies.migrateDatabase) {
      if (!manifest.steps.some((step) => step.key === legacyMigrationStep)) {
        await dependencies.migrateDatabase(secrets.databaseUrl, join(runtimeDirectory, 'drizzle'));
      }
    } else {
      const prepareDatabase = dependencies.prepareDatabase ?? releaseDatabaseLock.prepareDatabase;
      if (!prepareDatabase) {
        throw new Error(
          'platform: The PostgreSQL lifecycle lock cannot verify or migrate this database.',
        );
      }
      await prepareDatabase(
        runtimeDirectory,
        runtime.database,
        sourcePlatformVersion,
        hadPriorWorkers,
      );
    }
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: now(),
        key: migrationStep,
        resultHash: runtime.database.schemaDigest,
      },
      now(),
    );
    manifest = {
      ...manifest,
      databaseSchemaDigest: runtime.database.schemaDigest,
      updatedAt: now(),
    };
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  } else if (releaseDatabaseLock.verifyDatabase) {
    await releaseDatabaseLock.verifyDatabase(runtimeDirectory, runtime.database);
    if (manifest.databaseSchemaDigest !== runtime.database.schemaDigest) {
      manifest = {
        ...manifest,
        databaseSchemaDigest: runtime.database.schemaDigest,
        updatedAt: now(),
      };
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
  }

  return manifest;
}

// Restore staged Workers before starting a new generation, then replan any
// newly created Worker that recovery had to retain.
async function recoverInterruptedPlatformWorkerCutover(
  manifest: PlatformInstallationManifest,
  interruptedCutover: NonNullable<ReturnType<typeof interruptedWorkerCutover>> | null,
  workerActions: ReadonlyArray<PlatformInstallPlanAction>,
  configs: ReturnType<typeof createPlatformWorkerConfigs>,
  previousConfigs: ReturnType<typeof createPlatformWorkerConfigs>,
  plan: PlatformInstallPlan,
  dependencies: PlatformInstallerDependencies,
  ids: Record<string, string>,
  zoneId: string,
  previousPublicEndpoints: boolean,
  hasEmailGatewayArtifact: boolean,
  runPinnedPlatformWrangler: typeof runPlatformWrangler,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<{
  manifest: PlatformInstallationManifest;
  workerActions: ReadonlyArray<PlatformInstallPlanAction>;
}> {
  if (interruptedCutover) {
    const recoveryOrder: ReadonlyArray<PlatformWorkerKey> = [
      'dispatch',
      'tail',
      'emailGateway',
      'proxy',
      'api',
    ];
    for (const key of recoveryOrder.filter((key) => interruptedCutover.staged.has(key))) {
      const snapshot = interruptedCutover.staged.get(key)!;
      const preservedRoutes = dependencies.recoverWorkerCutover
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(
            dependencies.client,
            plan,
            snapshot.workerName,
          );
      const recoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...configs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      const previousRecoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...previousConfigs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      if (dependencies.recoverWorkerCutover) {
        await dependencies.recoverWorkerCutover({
          key,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          previousVersionId: snapshot.previousVersionId,
          stagedVersionId: snapshot.stagedVersionId,
          workerName: snapshot.workerName,
        });
      } else {
        const recoveryTraffic = isolatePlatformWorkerCustomDomains(recoveryConfig);
        const previousRecoveryTraffic = isolatePlatformWorkerCustomDomains(previousRecoveryConfig);
        await rollbackPlatformWorker({
          accountId: plan.account.id,
          activatedDeploymentId: null,
          activatedVersionId: snapshot.stagedVersionId,
          config: recoveryConfig,
          nextTriggers: readTriggerConfigFromObject(recoveryTraffic.wranglerConfig),
          previousConfig: previousRecoveryConfig,
          previousCustomDomains: previousRecoveryTraffic.customDomains,
          previousDeployment: null,
          previousTriggers: mergePreservedTriggerRoutes(
            withoutPlatformCustomDomainTriggers(snapshot.previousTriggers),
            preservedRoutes,
          ),
          previousVersionId: snapshot.previousVersionId,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          inspectNewWorker: () =>
            inspectNewPlatformWorker(
              dependencies.client,
              plan.account.id,
              manifest!,
              key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`,
              snapshot.workerName,
            ),
          removeCustomDomains: async () => {
            if (!dependencies.client.removeRoutes) {
              throw new Error('platform: Cloudflare route removal is unavailable.');
            }
            await dependencies.client.removeRoutes(
              plan.account.id,
              zoneId,
              trackedPlatformWorkerTraffic(manifest!, new Set([snapshot.workerName])),
            );
          },
          publishCustomDomains: (workerName, origins) =>
            publishPlatformWorkerCustomDomains(
              dependencies.client,
              plan.account.id,
              workerName,
              origins,
            ),
          retainNewWorker: async () => {
            await dependencies.client.putKvValue(
              plan.account.id,
              requireId(ids, 'routing-kv'),
              PLATFORM_DISABLED_KEY,
              PLATFORM_DISABLED_VALUE,
            );
          },
          runner: runPinnedPlatformWrangler,
          workerExisted: snapshot.previousVersionId !== null,
          workerName: snapshot.workerName,
        });
      }
    }
    manifest = recordWorkerCutoverResolution(
      manifest,
      interruptedCutover.generation,
      'restored',
      now(),
    );
    manifest = recordWorkerTrafficState(
      manifest,
      interruptedCutover.generation,
      previousPublicEndpoints && interruptedCutover.unsafeTraffic.size === 0,
      now(),
    );
    let retainedNewWorker = false;
    for (const [, snapshot] of interruptedCutover.staged) {
      if (snapshot.previousVersionId !== null) {
        continue;
      }
      retainedNewWorker = true;
    }
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    if (retainedNewWorker) {
      if (!dependencies.replanWorkers) {
        throw new Error(
          'platform: Recovering retained Workers requires a fresh Cloudflare installation plan.',
        );
      }
      workerActions = validateReplannedWorkerActions(
        plan,
        manifest,
        await dependencies.replanWorkers(manifest),
      ).filter((action) => hasEmailGatewayArtifact || action.key !== 'email-gateway-worker');
    }
  }
  return { manifest, workerActions };
}

// Preserve the routing gate first; rollback and manifest failure checkpoints
// follow while the database lifecycle lock is still held by the caller.
async function recoverFailedPlatformInstallation(
  error: unknown,
  manifest: PlatformInstallationManifest,
  plan: PlatformInstallPlan,
  dependencies: PlatformInstallerDependencies,
  workerTrafficGuarded: boolean,
  workerDeploymentCommitted: boolean,
  workerRollbacks: Array<PlatformWorkerRollback>,
  authenticationEnforcementActive: boolean,
  authenticationProtocolTransition: boolean,
  workerCutoverGeneration: number,
  previousPublicEndpoints: boolean,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
): Promise<unknown> {
  let failure: unknown = error;
  const currentWorkerRecoveryIncomplete = error instanceof PlatformWorkerRecoveryIncompleteError;
  if (workerTrafficGuarded) {
    try {
      await dependencies.client.putKvValue(
        plan.account.id,
        requireId(
          Object.fromEntries(manifest.resources.map((resource) => [resource.key, resource.id])),
          'routing-kv',
        ),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
    } catch (guardError) {
      failure = new Error(
        `platform: ${errorMessage(error)} The installation also failed to retain its routing safety gate: ${errorMessage(guardError)}`,
        { cause: error },
      );
    }
  }
  if (
    !workerDeploymentCommitted &&
    workerRollbacks.length > 0 &&
    !(authenticationEnforcementActive && authenticationProtocolTransition)
  ) {
    const rollbackFailures: Array<string> = [];
    for (const rollback of workerRollbacks.reverse()) {
      try {
        await rollback();
      } catch (rollbackError) {
        rollbackFailures.push(errorMessage(rollbackError));
      }
    }
    workerRollbacks = [];
    if (rollbackFailures.length > 0 || currentWorkerRecoveryIncomplete) {
      failure = new Error(
        rollbackFailures.length > 0
          ? `platform: ${errorMessage(error)} Automatic Worker rollback was incomplete: ${rollbackFailures.join('; ')} Inspect the installation before retrying.`
          : `platform: ${errorMessage(error)} The current Worker rollback was incomplete. The cutover remains unresolved and will be recovered on retry.`,
        { cause: error },
      );
    } else if (workerCutoverGeneration > 0) {
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'restored',
        now(),
      );
      manifest = recordWorkerTrafficState(
        manifest,
        workerCutoverGeneration,
        previousPublicEndpoints,
        now(),
      );
      writeInstallationManifest(manifest);
    }
  } else if (authenticationEnforcementActive && authenticationProtocolTransition) {
    // Traffic remains closed and retry resumes toward a fully compatible Worker set.
    workerRollbacks = [];
  }
  if (manifest.status !== 'failed' && manifest.status !== 'uninstalled') {
    try {
      manifest = transitionInstallation(manifest, 'failed', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    } catch {
      // Preserve the original failure when a terminal state cannot transition.
    }
  }
  return failure;
}

export async function installPlatform(
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  existing: PlatformInstallationManifest | null,
  dependencies: PlatformInstallerDependencies,
): Promise<PlatformInstallationResult> {
  if (plan.actions.some((action) => action.action === 'inspect')) {
    throw new Error(
      'platform: AI Gateway access must be verified before provisioning. Provide AI Gateway: Edit on the runtime token, then retry.',
    );
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const cloudflareApiBaseUrl = dependencies.client.apiBaseUrl ?? resolvePinnedApiBaseUrl();
  const runPinnedPlatformWrangler: typeof runPlatformWrangler = (args, accountId, cwd, capture) =>
    runPlatformWranglerAtApiBase(args, accountId, cwd, capture, cloudflareApiBaseUrl);
  const runParallelPinnedPlatformWrangler: typeof runPlatformWrangler = (
    args,
    accountId,
    cwd,
    capture,
  ) => runPlatformWranglerAtApiBase(args, accountId, cwd, capture, cloudflareApiBaseUrl, true);
  const resolvedRuntime = dependencies.runtime ?? resolvePlatformRuntime();
  const runtimeDirectory = resolvedRuntime.directory;
  const runtime = resolvedRuntime.manifest;
  const hasEmailGatewayArtifact = runtime.artifacts.emailGateway !== undefined;
  if (runtime.emailProtocolVersion !== 1 && plan.deployment.capabilities.email) {
    throw new Error(
      'platform: This runtime cannot serve enabled platform email without email protocol version 1.',
    );
  }
  if (
    runtime.emailProtocolVersion !== 1 &&
    existing?.resources.some(
      (resource) => resource.key === 'email-gateway-worker' && resource.state === 'ready',
    )
  ) {
    throw new Error(
      'platform: This runtime cannot replace an installed email gateway Worker. Use a runtime with email protocol version 1.',
    );
  }
  const workerKeys: ReadonlyArray<PlatformWorkerKey> = hasEmailGatewayArtifact
    ? ['api', 'proxy', 'emailGateway', 'tail', 'dispatch']
    : ['api', 'proxy', 'tail', 'dispatch'];
  if (plan.deployment.authentication.configurable && runtime.authenticationProtocolVersion !== 1) {
    throw new Error(
      'platform: This runtime does not support configurable authentication. Upgrade Void or use a compatible runtime.',
    );
  }
  if (plan.deployment.application.workersDev && runtime.applicationRoutingVersion !== 1) {
    throw new Error(
      'platform: This runtime does not support workers.dev application routing. Use a current platform runtime.',
    );
  }
  verifyRuntimeArtifacts(runtimeDirectory, runtime);
  const hyperdriveAction = plan.actions.find((action) => action.key === 'hyperdrive');
  const recordedHyperdrive = existing?.resources.find((resource) => resource.key === 'hyperdrive');
  let externalHyperdriveOriginHash: string | undefined;
  if (
    hyperdriveAction &&
    (hyperdriveAction.action === 'adopt' || recordedHyperdrive?.ownership === 'adopted')
  ) {
    if (!hyperdriveAction.id) {
      throw new Error('platform: The externally managed Hyperdrive has no ID.');
    }
    if (!plan.externalHyperdrive && !recordedHyperdrive) {
      throw new Error('platform: The externally managed Hyperdrive origin must be specified.');
    }
    const live = await dependencies.client.getHyperdriveConfig(
      plan.account.id,
      hyperdriveAction.id,
    );
    externalHyperdriveOriginHash = verifyExternalPlatformHyperdrive({
      config: live,
      databaseUrl: secrets.databaseUrl,
      expected: {
        id: hyperdriveAction.id,
        name: hyperdriveAction.name,
        host: plan.externalHyperdrive?.host ?? live.origin.host,
        user: plan.externalHyperdrive?.user ?? live.origin.user ?? '',
      },
      ...(recordedHyperdrive ? { recordedHash: recordedHyperdrive.configHash } : {}),
    });
  }
  const runtimeProvenance = {
    manifestSha256: resolvedRuntime.manifestSha256,
    source: resolvedRuntime.source,
    sourceRevision: runtime.sourceRevision,
  } as const;
  const version = runtime.platformVersion;
  const targetUsageProtocolVersion = runtime.usageProtocolVersion;
  const sourcePlatformVersion = existing?.platformVersion ?? null;
  const hadPriorWorkers =
    existing !== null &&
    (existing.resources.some(
      (resource) => resource.kind === 'worker' && resource.state === 'ready',
    ) ||
      plan.actions.some((action) => action.kind === 'worker' && action.action !== 'create'));
  const wasDisabled = existing?.status === 'disabled';
  const preserveDisabled = existing?.desiredState === 'disabled';
  const shouldBootstrapSharedEmail =
    !preserveDisabled &&
    plan.deployment.capabilities.email &&
    runtime.emailProtocolVersion === 1 &&
    !!plan.deployment.emailSharedZoneId;
  const previousPublicEndpoints = stablePublicEndpointState(existing);
  const authenticationProtocolTransition =
    hadPriorWorkers &&
    existing?.deployment.authentication.configurable !== true &&
    runtime.authenticationProtocolVersion === 1;
  let workerCutoverGeneration = 0;
  let workerRollbacks: Array<PlatformWorkerRollback> = [];
  let workerDeploymentCommitted = false;
  let workerTrafficGuarded = false;
  let authenticationEnforcementActive = false;
  let manifest = existing;
  if (!manifest) {
    const createdAt = now();
    manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt,
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: randomBytes(32).toString('base64url'),
      platformVersion: version,
    });
    manifest = transitionInstallation(manifest, 'planned', now());
    writeInstallationManifest(manifest);
  } else if (manifest.status === 'uninstalled') {
    throw new Error(`platform: Installation ${manifest.id} has already been uninstalled.`);
  }
  const explicitWorkerSecretUpdates = sanitizeWorkerSecretUpdates(secrets.workerSecretUpdates);
  const hasExplicitWorkerSecretUpdates = Object.keys(explicitWorkerSecretUpdates).length > 0;
  const resumedWorkerSecretUpdateIntent =
    secrets.pendingWorkerSecretUpdateIntent &&
    platformWorkerSecretUpdateIntentState(manifest, secrets.pendingWorkerSecretUpdateIntent) ===
      'active'
      ? secrets.pendingWorkerSecretUpdateIntent
      : null;
  let workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null =
    hasExplicitWorkerSecretUpdates
      ? {
          baselineGeneration: latestPlatformWorkerCutoverGeneration(manifest),
          generation: null,
          id: randomUUID(),
          schema: 1,
          updates: {
            ...resumedWorkerSecretUpdateIntent?.updates,
            ...explicitWorkerSecretUpdates,
          },
        }
      : resumedWorkerSecretUpdateIntent;
  if (preserveDisabled && manifest.desiredState !== 'disabled') {
    manifest = setInstallationDesiredState(manifest, 'disabled', now());
    writeInstallationManifest(manifest);
  }
  assertRequiredPlatformSecrets(plan, manifest, secrets, !!dependencies.prepareAuthentication);
  if (hyperdriveAction?.action === 'create') {
    // Reject a URL Hyperdrive can never accept before the claim binds it to this installation.
    parsePostgresConnectionString(secrets.databaseUrl);
    assertVoidCreatedHyperdriveTrustsDatabase(secrets.databaseUrl);
  }
  const pendingSecrets = secretCheckpoint(secrets, workerSecretUpdateIntent);
  writePendingInstallationSecrets(manifest, {
    ...pendingSecrets,
    databaseClaimState: 'claiming',
  });

  dependencies.onProgress?.('Preparing the platform database');
  try {
    await (dependencies.claimDatabase ?? claimPlatformDatabase)(
      secrets.databaseUrl,
      manifest.id,
      manifest.ownershipNonce,
    );
  } catch (error) {
    writePendingInstallationSecrets(manifest, {
      ...pendingSecrets,
      databaseClaimState: 'failed',
    });
    throw error;
  }
  writePendingInstallationSecrets(manifest, {
    ...pendingSecrets,
    databaseClaimState: 'claimed',
  });
  dependencies.onProgress?.('Acquiring the database lock');
  const releaseDatabaseLock = await dependencies.acquireDatabaseLifecycleLock(
    secrets.databaseUrl,
    manifest.id,
    manifest.ownershipNonce,
  );
  const writeRemoteInstallationCheckpoint = (
    client: InstallerClient,
    checkpointPlan: PlatformInstallPlan,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteInstallationCheckpointWithoutDatabase(
      client,
      checkpointPlan,
      checkpointManifest,
      releaseDatabaseLock,
    );
  const authoritative = releaseDatabaseLock.authoritativeManifest;
  if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(manifest)) {
    writeInstallationManifest(authoritative);
    await releaseDatabaseLock();
    throw new Error(
      'platform: This installation changed on another host. Local state was refreshed; rerun the command to review a current plan.',
    );
  }
  try {
    assertPlatformWorkerSecretUpdateAuthority({
      explicitUpdates: explicitWorkerSecretUpdates,
      localIntent: secrets.pendingWorkerSecretUpdateIntent,
      manifest,
      requiresEmailSigningSecret:
        manifest.deployment.capabilities.email || plan.deployment.capabilities.email,
    });
  } catch (error) {
    await releaseDatabaseLock();
    throw error;
  }
  if (
    workerSecretUpdateIntent &&
    !hasExplicitWorkerSecretUpdates &&
    platformWorkerSecretUpdateIntentState(manifest, workerSecretUpdateIntent) !== 'active'
  ) {
    workerSecretUpdateIntent = null;
  }
  let workerDeploymentSecrets: PlatformInstallationSecrets = {
    ...secrets,
    workerSecretUpdates: workerSecretUpdateIntent?.updates ?? {},
  };
  try {
    assertPlatformRuntimeSafety(
      runtime,
      manifest.safetyProtocols,
      releaseDatabaseLock.requiredSafetyProtocols,
    );
    if (existing) {
      await dependencies.verifyExistingOwnership?.(
        manifest,
        authoritative !== null && authoritative !== undefined,
      );
    }

    const liveAuthentication = await releaseDatabaseLock.readAuthenticationState?.();
    if (liveAuthentication) {
      authenticationEnforcementActive = liveAuthentication.sessionsRequired;
      if (liveAuthentication.sessionsRequired && runtime.authenticationProtocolVersion !== 1) {
        throw new Error(
          'platform: This runtime cannot enforce the active authentication configuration. Use an authentication-compatible runtime.',
        );
      }
      const deployment = mergePlatformLiveAuthenticationDeployment(
        plan.deployment,
        liveAuthentication,
      );
      plan = { ...plan, deployment };
      if (!authenticationProtocolTransition) {
        manifest = { ...manifest, deployment };
      }
    }
    if (
      !liveAuthentication &&
      manifest.deployment.authentication.configurable &&
      !plan.deployment.authentication.configurable
    ) {
      const authentication = manifest.deployment.authentication;
      const providers = authentication.providers;
      plan = {
        ...plan,
        deployment: createPlatformDeploymentManifest({
          ...plan.deployment,
          authentication,
          capabilities: {
            ...plan.deployment.capabilities,
            githubOAuth: providers.includes('github'),
            googleOAuth: providers.includes('google'),
          },
        }),
      };
    }
    if (authenticationProtocolTransition && !plan.deployment.authentication.configurable) {
      const providers = plan.deployment.authentication.providers;
      const deployment = createPlatformDeploymentManifest({
        ...plan.deployment,
        authentication: { providers, configurable: true },
        capabilities: {
          ...plan.deployment.capabilities,
          githubOAuth: providers.includes('github'),
          googleOAuth: providers.includes('google'),
        },
      });
      plan = { ...plan, deployment };
    }
    const activateAccessCredentials = () => {
      if (!secrets.accessCredentialsJson) {
        return;
      }
      const credentials: unknown = JSON.parse(secrets.accessCredentialsJson);
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        throw new Error('platform: Invalid saved Access credentials.');
      }
      // Lifecycle HTTP calls use API/proxy origins. Retain optional dashboard credentials
      // in recovery storage without activating them, including after protection removal.
      const origins = [plan.apiUrl, plan.proxyUrl];
      activatePlatformAccessCredentials(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(credentials).filter(([origin]) => origins.includes(origin)),
          ),
        ),
        origins,
      );
    };
    activateAccessCredentials();
    manifest = checkpointAuthenticationResources(manifest, secrets, now());
    writeInstallationManifest(manifest);
    await releaseDatabaseLock.checkpoint?.(manifest);
    dependencies.onProgress?.('Checking and creating Cloudflare resources');
    if (
      !authenticationProtocolTransition &&
      JSON.stringify(manifest.deployment) !== JSON.stringify(plan.deployment)
    ) {
      manifest = { ...manifest, deployment: plan.deployment, updatedAt: now() };
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
    }
    await releaseDatabaseLock.checkpoint?.(manifest);
    if (manifest.status !== 'provisioning') {
      manifest = transitionInstallation(manifest, 'provisioning', now());
      writeInstallationManifest(manifest);
    }

    if (dependencies.prepareAuthentication) {
      dependencies.onProgress?.('Preparing platform authentication');
      try {
        secrets = { ...secrets, ...(await dependencies.prepareAuthentication(manifest, secrets)) };
      } catch (error) {
        // Preserve provider secrets/ambiguous-create intents written while the preparation
        // hook was running; the outer failure checkpoint must not erase that recovery data.
        const latest = readPendingInstallationSecrets(manifest) ?? {};
        secrets = {
          ...secrets,
          authenticationPreparation: Object.fromEntries(
            Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
          ),
          authenticationSetupJson:
            latest.authenticationSetupJson || secrets.authenticationSetupJson,
          authSetupToken: latest.authSetupToken || secrets.authSetupToken,
          authBootstrapCode: latest.authBootstrapCode || secrets.authBootstrapCode,
          accessProvisioningJson: latest.accessProvisioningJson || secrets.accessProvisioningJson,
          accessCredentialsJson: latest.accessCredentialsJson || secrets.accessCredentialsJson,
        };
        manifest = checkpointAuthenticationResources(manifest, secrets, now());
        writeInstallationManifest(manifest);
        await releaseDatabaseLock.checkpoint?.(manifest);
        throw error;
      }
      const latest = readPendingInstallationSecrets(manifest) ?? {};
      secrets = {
        ...secrets,
        authenticationPreparation: Object.fromEntries(
          Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
        ),
      };
      manifest = checkpointAuthenticationResources(manifest, secrets, now());
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
      activateAccessCredentials();
      assertRequiredPlatformSecrets(plan, manifest, secrets);
      if (
        secrets.authenticationSetupJson &&
        createHash('sha256')
          .update(secrets.authBootstrapCode ?? '')
          .digest('hex') !==
          parsePlatformAuthenticationSetup(JSON.parse(secrets.authenticationSetupJson))
            .bootstrapCredentialHash
      ) {
        throw new Error(
          'platform: Prepared authentication does not match its administrator setup code.',
        );
      }
      workerDeploymentSecrets = {
        ...secrets,
        workerSecretUpdates: workerSecretUpdateIntent?.updates ?? {},
      };
      writePendingInstallationSecrets(manifest, {
        ...secretCheckpoint(secrets, workerSecretUpdateIntent),
        databaseClaimState: 'claimed',
      });
    }

    if (plan.deployment.authentication.accessProtection) {
      const protection = liveAuthentication
        ? liveAuthentication.protection
        : secrets.authenticationSetupJson
          ? parsePlatformAuthenticationSetup(JSON.parse(secrets.authenticationSetupJson)).protection
          : null;
      if (!protection) {
        throw new Error(
          'platform: The active Access protection configuration is unavailable. Restore its database and encrypted setup checkpoint before maintenance.',
        );
      }
      dependencies.onProgress?.('Verifying current Access policies and protected origins');
      await (dependencies.verifyAccessProtection ?? verifyInstalledPlatformAccessProtection)({
        client: dependencies.client,
        manifest,
        plan,
        protection,
        checkpoint: secretCheckpoint(secrets, workerSecretUpdateIntent),
      });
    }

    // Establish the durable installation checkpoint before creating any
    // resource that may need to be reconciled or removed after interruption.
    const routingAction = plan.actions.find((action) => action.key === 'routing-kv')!;
    if (routingAction.action === 'adopt') {
      throw new Error('platform: The routing checkpoint cannot be adopted.');
    }
    if (routingAction.action === 'reuse') {
      if (
        !manifest.resources.some((resource) => resource.key === routingAction.key) &&
        routingAction.id
      ) {
        manifest = recordResource(manifest, routingAction, routingAction.id, 'created', now());
        writeInstallationManifest(manifest);
      }
    } else {
      manifest = recordProvisionIntent(manifest, routingAction, now());
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
      const routing = await createResource(
        dependencies.client,
        plan,
        routingAction,
        secrets.databaseUrl,
        '',
      );
      manifest = recordResource(manifest, routingAction, routing.id, 'created', now());
      writeInstallationManifest(manifest);
    }
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);

    const zoneAction = plan.actions.find((action) => action.key === 'zone');
    let zone = plan.zone;
    if (zoneAction) {
      if (zoneAction.action === 'create') {
        manifest = recordProvisionIntent(manifest, zoneAction, now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        zone = await dependencies.client.createZone(plan.account.id, zoneAction.name);
      }
      if (!zone) {
        throw new Error('platform: Cloudflare did not return the platform zone.');
      }
      if (zoneAction.action === 'adopt') {
        manifest = recordAdoptionIntent(manifest, zoneAction, zone.id, now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      }
      manifest = recordResource(
        manifest,
        zoneAction,
        zone.id,
        zoneAction.action === 'adopt'
          ? 'adopted'
          : zoneAction.action === 'create' || hasProvisionIntent(manifest, zoneAction)
            ? 'created'
            : undefined,
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      if (zone.status !== 'active') {
        manifest = transitionInstallation(manifest, 'waiting-for-dns', now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        return {
          manifest,
          waitingForDns: true,
          waitingForSandboxDrain: false,
          zoneNameServers: zone.nameServers,
        };
      }
    }
    const zoneId = zone?.id ?? '';
    manifest = await reconcilePlatformInstallationResources(
      manifest,
      plan,
      secrets,
      zoneId,
      externalHyperdriveOriginHash,
      dependencies,
      now,
      writeRemoteInstallationCheckpoint,
      (next) => {
        manifest = next;
      },
    );

    dependencies.onProgress?.('Verifying uncached authentication database reads');
    const authenticationDatabase = manifest.resources.find(
      (resource) => resource.key === 'hyperdrive',
    );
    if (!authenticationDatabase) {
      throw new Error('platform: The authentication database resource is missing.');
    }
    await verifyPlatformAuthenticationDatabase(
      dependencies.client,
      plan.account.id,
      authenticationDatabase,
      secrets.databaseUrl,
    );

    manifest = await preparePlatformDatabaseSchema(
      manifest,
      runtime,
      runtimeDirectory,
      sourcePlatformVersion,
      hadPriorWorkers,
      plan,
      secrets,
      dependencies,
      releaseDatabaseLock,
      now,
      writeRemoteInstallationCheckpoint,
      (next) => {
        manifest = next;
      },
    );

    dependencies.onProgress?.('Checking platform safety');
    const targetSandboxDrainProtocol = runtime.safetyProtocols?.sandboxDrain ?? 0;
    const prepareSandboxDrain =
      dependencies.prepareSandboxDrain ?? releaseDatabaseLock.prepareSandboxDrain;
    if (targetSandboxDrainProtocol >= 1 && !prepareSandboxDrain) {
      throw new Error(
        'platform: The PostgreSQL lifecycle lock cannot establish the sandbox-drain safety checkpoint.',
      );
    }
    const sandboxDrainPreparation =
      targetSandboxDrainProtocol >= 1
        ? await prepareSandboxDrain!(
            targetSandboxDrainProtocol >= 3 ? 3 : targetSandboxDrainProtocol >= 2 ? 2 : 0,
          )
        : null;
    if (
      sandboxDrainPreparation &&
      sandboxDrainPreparation.admissionProtocol < targetSandboxDrainProtocol
    ) {
      throw new Error(
        'platform: The database did not arm the Sandbox admission protocol required by this runtime.',
      );
    }
    const sandboxDrainRoutingKvId = requireId(
      Object.fromEntries(manifest.resources.map((resource) => [resource.key, resource.id])),
      'routing-kv',
    );
    const writeSandboxDrainMirror = async (preparation: PlatformSandboxDrainPreparation) => {
      await dependencies.client.putKvValue(
        plan.account.id,
        sandboxDrainRoutingKvId,
        PLATFORM_SANDBOX_DRAIN_KEY,
        preparation.mirrorValue,
      );
    };
    if (sandboxDrainPreparation) {
      await writeSandboxDrainMirror(sandboxDrainPreparation);
    }
    const sandboxDrainState = sandboxDrainPreparation?.state ?? 'complete';
    if (
      targetSandboxDrainProtocol >= 1 &&
      (manifest.safetyProtocols?.sandboxDrain ?? 0) < targetSandboxDrainProtocol
    ) {
      manifest = {
        ...manifest,
        safetyProtocols: { sandboxDrain: targetSandboxDrainProtocol },
        updatedAt: now(),
      };
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    manifest = transitionInstallation(manifest, 'deploying', now());
    writeInstallationManifest(manifest);
    const ids = Object.fromEntries(
      manifest.resources.map((resource) => [resource.key, resource.id]),
    );
    const bootstrapStep = 'bootstrap-access:v1';
    if (!manifest.steps.some((step) => step.key === bootstrapStep)) {
      const routingKv = requireId(ids, 'routing-kv');
      await dependencies.client.putKvValue(plan.account.id, routingKv, 'signup:enabled', 'true');
      await dependencies.client.putKvValue(
        plan.account.id,
        routingKv,
        'signup:allowlist',
        JSON.stringify([]),
      );
      manifest = recordInstallationStep(
        manifest,
        {
          completedAt: now(),
          key: bootstrapStep,
          resultHash: hash(secrets.authenticationSetupJson ?? secrets.bootstrapGitHubId),
        },
        now(),
      );
      writeInstallationManifest(manifest);
    }
    const entrypoints = Object.fromEntries(
      Object.entries(runtime.artifacts).map(([key, artifact]) => [
        key,
        join(runtimeDirectory, artifact.path),
      ]),
    ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string> &
      Partial<Record<'emailGateway', string>>;
    let interruptedCutover = interruptedWorkerCutover(manifest);
    if (interruptedCutover && authenticationProtocolTransition && authenticationEnforcementActive) {
      manifest = recordWorkerCutoverResolution(
        manifest,
        interruptedCutover.generation,
        'committed',
        now(),
      );
      manifest = recordWorkerTrafficState(manifest, interruptedCutover.generation, false, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      interruptedCutover = null;
    }
    const recoveringUnsafeTraffic = (interruptedCutover?.unsafeTraffic.size ?? 0) > 0;
    const createsWorker = plan.actions.some(
      (action) =>
        action.kind === 'worker' &&
        action.action === 'create' &&
        (hasEmailGatewayArtifact || action.key !== 'email-gateway-worker'),
    );
    const recoveringCreatedWorker =
      interruptedCutover !== null &&
      [...interruptedCutover.staged.values()].some(
        (snapshot) => snapshot.previousVersionId === null,
      );
    const requiresSandboxDrain =
      !preserveDisabled && targetSandboxDrainProtocol >= 1 && sandboxDrainState === 'pending';
    const requiresTrafficGuard =
      !previousPublicEndpoints ||
      recoveringUnsafeTraffic ||
      createsWorker ||
      recoveringCreatedWorker ||
      manifest.usageProtocolVersion !== targetUsageProtocolVersion ||
      authenticationProtocolTransition ||
      shouldBootstrapSharedEmail ||
      requiresSandboxDrain;
    if (requiresTrafficGuard) {
      await dependencies.client.putKvValue(
        plan.account.id,
        requireId(ids, 'routing-kv'),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
      workerTrafficGuarded = true;
    }
    if (!preserveDisabled) {
      const trafficGeneration = nextTrafficGeneration(manifest);
      manifest = recordInstallationStep(
        manifest,
        {
          completedAt: now(),
          key: `traffic-enabled:${trafficGeneration}`,
          resultHash: String(trafficGeneration),
        },
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    const configInput = {
      authenticationDatabaseUncached: true,
      accountId: plan.account.id,
      apiUrl: plan.apiUrl,
      deployment: plan.deployment,
      healthProbeToken: createPlatformHealthProbeToken(manifest.ownershipNonce),
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      platformVersion: version,
      proxyUrl: plan.proxyUrl,
      emailGatewayUrl: `https://${plan.deployment.resources.emailGatewayWorker}.${plan.workersSubdomain}.workers.dev`,
      resources: {
        hyperdrive: requireId(ids, 'hyperdrive'),
        isrCacheKv: requireId(ids, 'isr-cache-kv'),
        legacyAssetsKv: requireId(ids, 'legacy-assets-kv'),
        routingKv: requireId(ids, 'routing-kv'),
        zone: zoneId,
      },
      runtimeEntrypoints: entrypoints as Record<PlatformWorkerKey, string>,
      ...(runtime.assets
        ? {
            runtimeApiAssetsDirectory: join(runtimeDirectory, PLATFORM_ADMIN_ASSETS_DIRECTORY),
          }
        : {}),
    };
    const requiresStagedCommit = !preserveDisabled && requiresTrafficGuard;
    const enabledConfigs = createPlatformWorkerConfigs({
      ...configInput,
      publicEndpoints: !preserveDisabled,
      trafficState: preserveDisabled ? 'staging' : 'enabled',
    });
    const configs = requiresStagedCommit
      ? createPlatformWorkerConfigs({
          ...configInput,
          publicEndpoints: true,
          trafficState: requiresSandboxDrain ? 'sandbox-drain' : 'staging',
        })
      : enabledConfigs;
    const previousConfigs = createPlatformWorkerConfigs({
      ...configInput,
      publicEndpoints: previousPublicEndpoints,
      trafficState: previousPublicEndpoints ? 'enabled' : 'staging',
    });
    const managedRoutes = platformManagedWorkerTraffic(plan.deployment).routes;
    let workerActions: ReadonlyArray<PlatformInstallPlanAction> = plan.actions.filter(
      (action) =>
        action.kind === 'worker' &&
        (hasEmailGatewayArtifact || action.key !== 'email-gateway-worker'),
    );
    ({ manifest, workerActions } = await recoverInterruptedPlatformWorkerCutover(
      manifest,
      interruptedCutover,
      workerActions,
      configs,
      previousConfigs,
      plan,
      dependencies,
      ids,
      zoneId,
      previousPublicEndpoints,
      hasEmailGatewayArtifact,
      runPinnedPlatformWrangler,
      now,
      writeRemoteInstallationCheckpoint,
      (next) => {
        manifest = next;
      },
    ));
    workerCutoverGeneration = nextWorkerCutoverGeneration(manifest);
    if (workerSecretUpdateIntent) {
      manifest = recordWorkerSecretUpdateState(
        manifest,
        workerCutoverGeneration,
        'pending',
        workerSecretUpdateIntent.id,
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      workerSecretUpdateIntent = {
        ...workerSecretUpdateIntent,
        generation: workerCutoverGeneration,
      };
      writePendingInstallationSecrets(
        manifest,
        secretCheckpoint(secrets, workerSecretUpdateIntent),
      );
    }
    const parallelWorkerUploads =
      !dependencies.deployWorker &&
      !requiresStagedCommit &&
      !workerSecretUpdateIntent &&
      !recoveringUnsafeTraffic &&
      workerActions.length === workerKeys.length &&
      workerActions.every((action) => action.action === 'update');
    let workerManifestQueue = Promise.resolve();
    let workerManifestFailed = false;
    let workerManifestFailure: unknown;
    const checkpointWorkerManifest = (
      update: () => Promise<void>,
      safetyRecovery = false,
    ): Promise<void> => {
      if (!parallelWorkerUploads) {
        return update();
      }
      const result = workerManifestQueue.then(async () => {
        if (workerManifestFailed && !safetyRecovery) {
          throw workerManifestFailure;
        }
        try {
          await update();
        } catch (error) {
          workerManifestFailed = true;
          workerManifestFailure = error;
          throw error;
        }
      });
      workerManifestQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    let availableUploadSlots = 2;
    let uploadFailure: unknown;
    const uploadWaiters: Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }> = [];
    const acquireUploadSlot = async (): Promise<(failure?: unknown) => void> => {
      if (uploadFailure !== undefined) {
        throw uploadFailure;
      }
      if (availableUploadSlots === 0) {
        await new Promise<void>((resolve, reject) => uploadWaiters.push({ resolve, reject }));
      } else {
        availableUploadSlots--;
      }
      return (failure) => {
        if (failure !== undefined && uploadFailure === undefined) {
          uploadFailure = failure;
          for (const waiter of uploadWaiters.splice(0)) {
            waiter.reject(failure);
          }
        }
        const next = uploadFailure === undefined ? uploadWaiters.shift() : undefined;
        if (next) {
          next.resolve();
        } else {
          availableUploadSlots++;
        }
      };
    };
    const workerReady = (parallelWorkerUploads ? workerKeys : []).map(() => {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      return { promise, resolve, reject };
    });
    const uploadBatch = Promise.all(workerReady.map((ready) => ready.promise)).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    const deployOneWorker = async (
      key: PlatformWorkerKey,
      waitForPriorWorker?: () => Promise<void>,
      onReadyForActivation?: () => Promise<void>,
    ): Promise<void> => {
      dependencies.onProgress?.(`Deploying the ${key} service`);
      let workerStepStarted = performance.now();
      const markWorkerStep = (step: string) => {
        if (process.env.VOID_PLATFORM_TIMINGS === '1') {
          process.stderr.write(
            `[platform timing] worker ${key} ${step} ${(performance.now() - workerStepStarted).toFixed(0)} ms\n`,
          );
        }
        workerStepStarted = performance.now();
      };
      const action = workerActions.find(
        (entry) =>
          entry.key === (key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`),
      )!;
      const workerSecrets = platformWorkerSecretPayload(
        key,
        workerDeploymentSecrets,
        plan.account.id,
        zoneId,
        action.action !== 'create',
      );
      await checkpointWorkerManifest(async () => {
        const intended = recordProvisionIntent(manifest!, action, now());
        if (intended !== manifest) {
          manifest = intended;
          writeInstallationManifest(manifest);
          await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        }
      });
      await dependencies.revalidateBeforeWorkerDeploy(manifest!, action);
      markWorkerStep('revalidate');
      const preservedRoutes = dependencies.deployWorker
        ? []
        : action.action === 'create'
          ? []
          : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
      markWorkerStep('traffic inventory');
      const workerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
      const previousWorkerConfig = mergePlatformWorkerTrafficConfig(
        previousConfigs[key],
        preservedRoutes,
      );
      const rollback = dependencies.deployWorker
        ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
        : await deployPlatformWorker(workerConfig, workerSecrets, {
            apiBaseUrl: cloudflareApiBaseUrl,
            ...(parallelWorkerUploads
              ? { acquireUploadSlot, onReadyForActivation, waitForPriorWorker }
              : {}),
            ...(dependencies.client.request
              ? { readCloudflare: (path) => dependencies.client.request!(path) }
              : {}),
            onStaged: async (previousVersionId, stagedVersionId, previousTriggers) => {
              await checkpointWorkerManifest(async () => {
                manifest = recordWorkerCutoverStage(
                  manifest!,
                  workerCutoverGeneration,
                  key,
                  previousVersionId,
                  stagedVersionId,
                  action.name,
                  previousTriggers,
                  now(),
                );
                writeInstallationManifest(manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
              });
            },
            onTrafficPublished: async () => {
              if (!dependencies.client.listWorkerDomains || !dependencies.client.listWorkerRoutes) {
                throw new Error('platform: Cloudflare traffic inventory is unavailable.');
              }
              const [customDomains, routes] = await Promise.all([
                dependencies.client.listWorkerDomains(plan.account.id),
                zoneId ? dependencies.client.listWorkerRoutes(zoneId) : Promise.resolve([]),
              ]);
              await checkpointWorkerManifest(async () => {
                const next = recordPlatformWorkerTraffic(
                  manifest!,
                  action.name,
                  { customDomains, routes },
                  now(),
                );
                if (JSON.stringify(next.resources) !== JSON.stringify(manifest!.resources)) {
                  manifest = next;
                  writeInstallationManifest(manifest);
                  await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
                }
              });
            },
            onUnsafeTraffic: async () => {
              await checkpointWorkerManifest(async () => {
                manifest = recordWorkerUnsafeTraffic(
                  manifest!,
                  workerCutoverGeneration,
                  key,
                  action.name,
                  now(),
                );
                writeInstallationManifest(manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
              }, true);
            },
            managedRoutes: preserveDisabled
              ? []
              : managedRoutes
                  .filter((route) => route.script === action.name)
                  .map((route) => route.pattern),
            preservedRoutes,
            publishCustomDomains: (workerName, origins) =>
              publishPlatformWorkerCustomDomains(
                dependencies.client,
                plan.account.id,
                workerName,
                origins,
              ),
            publishRoutes: async (workerName, patterns) => {
              if (!dependencies.client.publishWorkerRoutesSafely) {
                throw new Error(
                  'platform: Safe Cloudflare Worker route publication is unavailable.',
                );
              }
              if (zoneId) {
                await dependencies.client.publishWorkerRoutesSafely(zoneId, workerName, patterns);
              } else if (patterns.length > 0) {
                throw new Error('platform: Cannot publish zone routes in workers.dev mode.');
              }
            },
            previousConfig: previousWorkerConfig,
            previousPublicEndpoints,
            inspectNewWorker: () =>
              inspectNewPlatformWorker(
                dependencies.client,
                plan.account.id,
                manifest!,
                action.key,
                action.name,
              ),
            removeCustomDomains: async () => {
              if (!dependencies.client.removeRoutes) {
                throw new Error('platform: Cloudflare route removal is unavailable.');
              }
              await dependencies.client.removeRoutes(
                plan.account.id,
                zoneId,
                trackedPlatformWorkerTraffic(manifest!, new Set([action.name])),
              );
            },
            retainNewWorker: async () => {
              await dependencies.client.putKvValue(
                plan.account.id,
                requireId(ids, 'routing-kv'),
                PLATFORM_DISABLED_KEY,
                PLATFORM_DISABLED_VALUE,
              );
            },
            runner: parallelWorkerUploads
              ? runParallelPinnedPlatformWrangler
              : runPinnedPlatformWrangler,
            workerExisted: action.action !== 'create',
          });
      markWorkerStep('deploy');
      if (rollback) {
        workerRollbacks.push(rollback);
      }
      await checkpointWorkerManifest(async () => {
        const recorded = recordResource(manifest!, action, action.name, 'created', now());
        if (
          rollback ||
          dependencies.deployWorker ||
          JSON.stringify(recorded.resources) !== JSON.stringify(manifest!.resources)
        ) {
          manifest = recorded;
          writeInstallationManifest(manifest);
          await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        }
      });
      markWorkerStep('record');
    };
    if (parallelWorkerUploads) {
      const tasks: Array<Promise<void>> = [];
      for (const [index, key] of workerKeys.entries()) {
        const priorWorker = tasks.at(-1);
        const ready = workerReady[index]!;
        const task = deployOneWorker(key, priorWorker ? () => priorWorker : undefined, async () => {
          ready.resolve();
          const batch = await uploadBatch;
          if (batch.error !== null) {
            throw batch.error;
          }
        });
        task.then(
          () => ready.resolve(),
          (error: unknown) => ready.reject(error),
        );
        tasks.push(task);
      }
      const results = await Promise.allSettled(tasks);
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (firstFailure) {
        throw firstFailure.reason;
      }
    } else {
      for (const key of workerKeys) {
        await deployOneWorker(key);
      }
    }

    manifest = setInstallationEndpoints(
      manifest,
      { apiUrl: plan.apiUrl, dashboardUrl: null, proxyUrl: plan.proxyUrl },
      now(),
    );
    if (preserveDisabled) {
      workerDeploymentCommitted = true;
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'committed',
        now(),
      );
      manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, false, now());
      if (workerSecretUpdateIntent) {
        manifest = recordWorkerSecretUpdateState(
          manifest,
          workerCutoverGeneration,
          'committed',
          workerSecretUpdateIntent.id,
          now(),
        );
      }
      manifest = {
        ...manifest,
        deployment: plan.deployment,
        platformVersion: version,
        runtime: runtimeProvenance,
        updatedAt: now(),
        usageProtocolVersion: targetUsageProtocolVersion,
      };
      manifest = transitionInstallation(manifest, 'disabled', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      writePendingInstallationSecrets(manifest, secretCheckpoint(secrets));
      promoteInstallationSecrets(manifest);
      saveInstalledPlatformConnection(plan, manifest);
      return {
        manifest,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: zone?.nameServers ?? [],
      };
    }
    let authenticationCutoverCommitted = false;
    if (authenticationProtocolTransition && requiresStagedCommit) {
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'committed',
        now(),
      );
      manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, false, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      // From this point onward the database may enforce revocable sessions. Retain the
      // compatible maintenance runtime on failure instead of restoring incapable Workers.
      workerRollbacks = [];
      authenticationCutoverCommitted = true;
    }
    let authenticationStep = secrets.authenticationSetupJson
      ? 'authentication-initialized:v1:' + hash(secrets.authenticationSetupJson)
      : '';
    let setupPending = false;
    manifest = transitionInstallation(manifest, 'verifying', now());
    writeInstallationManifest(manifest);
    if (plan.deployment.authentication.configurable && authenticationStep) {
      if (!secrets.authenticationSetupJson || !secrets.authSetupToken) {
        throw new Error(
          'platform: Restore the encrypted authentication setup checkpoint before resuming.',
        );
      }
      dependencies.onProgress?.('Initializing platform authentication');
      const authentication = await resumeInstalledPlatformAuthentication(
        {
          apiUrl: plan.apiUrl,
          installationId: manifest.id,
          setupToken: secrets.authSetupToken,
          setupJson: secrets.authenticationSetupJson,
          checkpoint: (replacement) => {
            secrets = { ...secrets, ...replacement };
            authenticationStep =
              'authentication-initialized:v1:' + hash(replacement.authenticationSetupJson);
            writePendingInstallationSecrets(
              manifest!,
              secretCheckpoint(secrets, workerSecretUpdateIntent),
            );
          },
        },
        dependencies.initializeAuthentication ?? initializeInstalledPlatformAuthentication,
      );
      if (authentication.setupPending) {
        setupPending = true;
        dependencies.onProgress?.(`Administrator setup pending: ${plan.apiUrl}/setup`);
      }
      manifest = recordInstallationStep(
        manifest,
        {
          key: authenticationStep,
          completedAt: now(),
          resultHash: hash(secrets.authenticationSetupJson),
        },
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    dependencies.onProgress?.('Verifying platform health');
    const emailGatewayUrl =
      hasEmailGatewayArtifact && plan.deployment.capabilities.email
        ? `https://${plan.deployment.resources.emailGatewayWorker}.${plan.workersSubdomain}.workers.dev`
        : undefined;
    if (plan.deployment.authentication.accessProtection) {
      ensurePlatformAccessToken(plan.apiUrl, false, true);
      ensurePlatformAccessToken(plan.proxyUrl, false, true);
    }
    const healthCheckContext: PlatformHealthCheckContext = {
      accountName: plan.account.name,
      workers: [
        plan.deployment.resources.apiWorker,
        plan.deployment.resources.proxyWorker,
        ...(emailGatewayUrl ? [plan.deployment.resources.emailGatewayWorker] : []),
        plan.deployment.resources.dispatchWorker,
      ],
      resumeCommand: dependencies.healthCheckResumeCommand,
      ...(emailGatewayUrl ? { emailGatewayUrl } : {}),
    };
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(
      plan.apiUrl,
      manifest.id,
      plan.proxyUrl,
      plan.deployment.application.baseDomain,
      version,
      targetUsageProtocolVersion,
      createPlatformHealthProbeToken(manifest.ownershipNonce),
      undefined,
      !plan.deployment.application.zoneName
        ? `https://${plan.deployment.resources.dispatchWorker}.${plan.workersSubdomain}.workers.dev`
        : undefined,
      healthCheckContext,
    );
    if (requiresSandboxDrain) {
      const drainComplete = await (dependencies.verifySandboxDrain ?? verifyPlatformSandboxDrain)(
        plan.apiUrl,
        createPlatformHealthProbeToken(manifest.ownershipNonce),
      );
      if (!drainComplete) {
        manifest = recordWorkerCutoverResolution(
          manifest,
          workerCutoverGeneration,
          'committed',
          now(),
        );
        manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, false, now());
        manifest = recordInstallationStep(
          manifest,
          {
            completedAt: now(),
            key: 'sandbox-drain:maintenance-runtime:v1',
            resultHash: resolvedRuntime.manifestSha256,
          },
          now(),
        );
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        workerRollbacks = [];
        workerDeploymentCommitted = true;
        saveInstalledPlatformConnection(plan, manifest);
        return {
          manifest,
          waitingForDns: false,
          waitingForSandboxDrain: true,
          zoneNameServers: zone?.nameServers ?? [],
        };
      }
      const completedDrain = await prepareSandboxDrain!();
      if (completedDrain.state !== 'complete') {
        throw new Error(
          'platform: Sandbox drain completion changed while it was being verified. Traffic remains disabled.',
        );
      }
      await writeSandboxDrainMirror(completedDrain);
    }
    if (requiresStagedCommit) {
      if (!authenticationCutoverCommitted) {
        manifest = recordWorkerCutoverResolution(
          manifest,
          workerCutoverGeneration,
          'committed',
          now(),
        );
        manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, false, now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        workerRollbacks = [];
      }

      workerCutoverGeneration = nextWorkerCutoverGeneration(manifest);
      if (workerSecretUpdateIntent) {
        manifest = recordWorkerSecretUpdateState(
          manifest,
          workerCutoverGeneration,
          'pending',
          workerSecretUpdateIntent.id,
          now(),
        );
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        workerSecretUpdateIntent = {
          ...workerSecretUpdateIntent,
          generation: workerCutoverGeneration,
        };
        writePendingInstallationSecrets(
          manifest,
          secretCheckpoint(secrets, workerSecretUpdateIntent),
        );
      }
      for (const key of workerKeys) {
        dependencies.onProgress?.(`Enabling the ${key} service`);
        const action = workerActions.find(
          (entry) =>
            entry.key === (key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`),
        )!;
        const workerSecrets = platformWorkerSecretPayload(
          key,
          workerDeploymentSecrets,
          plan.account.id,
          zoneId,
          action.action !== 'create',
        );
        const preservedRoutes = dependencies.deployWorker
          ? []
          : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
        const workerConfig = mergePlatformWorkerTrafficConfig(enabledConfigs[key], preservedRoutes);
        const previousWorkerConfig = mergePlatformWorkerTrafficConfig(
          configs[key],
          preservedRoutes,
        );
        const rollback = dependencies.deployWorker
          ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
          : await deployPlatformWorker(workerConfig, workerSecrets, {
              apiBaseUrl: cloudflareApiBaseUrl,
              ...(dependencies.client.request
                ? { readCloudflare: (path) => dependencies.client.request!(path) }
                : {}),
              onStaged: async (previousVersionId, stagedVersionId, previousTriggers) => {
                manifest = recordWorkerCutoverStage(
                  manifest!,
                  workerCutoverGeneration,
                  key,
                  previousVersionId,
                  stagedVersionId,
                  action.name,
                  previousTriggers,
                  now(),
                );
                writeInstallationManifest(manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
              },
              onTrafficPublished: async () => {
                if (
                  !dependencies.client.listWorkerDomains ||
                  !dependencies.client.listWorkerRoutes
                ) {
                  throw new Error('platform: Cloudflare traffic inventory is unavailable.');
                }
                const [customDomains, routes] = await Promise.all([
                  dependencies.client.listWorkerDomains(plan.account.id),
                  zoneId ? dependencies.client.listWorkerRoutes(zoneId) : Promise.resolve([]),
                ]);
                const next = recordPlatformWorkerTraffic(
                  manifest!,
                  action.name,
                  { customDomains, routes },
                  now(),
                );
                if (JSON.stringify(next.resources) !== JSON.stringify(manifest!.resources)) {
                  manifest = next;
                  writeInstallationManifest(manifest);
                  await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
                }
              },
              onUnsafeTraffic: async () => {
                manifest = recordWorkerUnsafeTraffic(
                  manifest!,
                  workerCutoverGeneration,
                  key,
                  action.name,
                  now(),
                );
                writeInstallationManifest(manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
              },
              managedRoutes: managedRoutes
                .filter((route) => route.script === action.name)
                .map((route) => route.pattern),
              preservedRoutes,
              publishCustomDomains: (workerName, origins) =>
                publishPlatformWorkerCustomDomains(
                  dependencies.client,
                  plan.account.id,
                  workerName,
                  origins,
                ),
              publishRoutes: async (workerName, patterns) => {
                if (!dependencies.client.publishWorkerRoutesSafely) {
                  throw new Error(
                    'platform: Safe Cloudflare Worker route publication is unavailable.',
                  );
                }
                if (zoneId) {
                  await dependencies.client.publishWorkerRoutesSafely(zoneId, workerName, patterns);
                } else if (patterns.length > 0) {
                  throw new Error('platform: Cannot publish zone routes in workers.dev mode.');
                }
              },
              previousConfig: previousWorkerConfig,
              previousPublicEndpoints: true,
              inspectNewWorker: () =>
                inspectNewPlatformWorker(
                  dependencies.client,
                  plan.account.id,
                  manifest!,
                  action.key,
                  action.name,
                ),
              removeCustomDomains: async () => {
                if (!dependencies.client.removeRoutes) {
                  throw new Error('platform: Cloudflare route removal is unavailable.');
                }
                await dependencies.client.removeRoutes(
                  plan.account.id,
                  zoneId,
                  trackedPlatformWorkerTraffic(manifest!, new Set([action.name])),
                );
              },
              retainNewWorker: async () => {
                await dependencies.client.putKvValue(
                  plan.account.id,
                  requireId(ids, 'routing-kv'),
                  PLATFORM_DISABLED_KEY,
                  PLATFORM_DISABLED_VALUE,
                );
              },
              // Traffic opens only after every Worker in this generation is
              // verified against its own staged checkpoint, so none may be reused.
              reuseMatchingVersion: false,
              runner: runPinnedPlatformWrangler,
              workerExisted: true,
            });
        if (rollback) {
          workerRollbacks.push(rollback);
        }
      }
    }
    const verifyCurrentWorkerCutover = async () => {
      if (!requiresStagedCommit) {
        return;
      }
      if (dependencies.verifyWorkerCutover) {
        await dependencies.verifyWorkerCutover(manifest!, workerCutoverGeneration);
      } else if (!dependencies.deployWorker) {
        await verifyPlatformWorkerCutoverVersions(
          manifest!,
          workerCutoverGeneration,
          enabledConfigs,
          plan.account.id,
          runPinnedPlatformWrangler,
          workerKeys,
        );
      }
    };
    await verifyCurrentWorkerCutover();
    let emailOperationId: string | undefined;
    if (shouldBootstrapSharedEmail) {
      // Shared-zone setup mutates provider routing. Once it begins, retain the
      // verified Worker set and keep the installation's routing gate closed on
      // failure so a retry can resume the durable email operation safely.
      workerDeploymentCommitted = true;
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'committed',
        now(),
      );
      if (workerSecretUpdateIntent) {
        manifest = recordWorkerSecretUpdateState(
          manifest,
          workerCutoverGeneration,
          'committed',
          workerSecretUpdateIntent.id,
          now(),
        );
      }
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      workerRollbacks = [];
      dependencies.onProgress?.('Preparing shared email routing');
      emailOperationId = await (dependencies.bootstrapEmail ?? bootstrapPlatformSharedEmail)(
        plan.apiUrl,
        createPlatformHealthProbeToken(manifest.ownershipNonce),
      );
    }
    if (dependencies.client.deleteKvValue) {
      await dependencies.client.deleteKvValue(
        plan.account.id,
        requireId(ids, 'routing-kv'),
        PLATFORM_DISABLED_KEY,
      );
    } else if (wasDisabled || !previousPublicEndpoints) {
      throw new Error('platform: Routing disablement removal is unavailable.');
    }
    if (requiresStagedCommit) {
      dependencies.onProgress?.('Verifying the enabled platform');
      await (dependencies.verifyHealth ?? verifyPlatformHealth)(
        plan.apiUrl,
        manifest.id,
        plan.proxyUrl,
        plan.deployment.application.baseDomain,
        version,
        targetUsageProtocolVersion,
        createPlatformHealthProbeToken(manifest.ownershipNonce),
        undefined,
        !plan.deployment.application.zoneName
          ? `https://${plan.deployment.resources.dispatchWorker}.${plan.workersSubdomain}.workers.dev`
          : undefined,
        healthCheckContext,
      );
      await verifyCurrentWorkerCutover();
    }
    workerDeploymentCommitted = true;
    manifest = recordWorkerCutoverResolution(manifest, workerCutoverGeneration, 'committed', now());
    manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, true, now());
    if (workerSecretUpdateIntent) {
      manifest = recordWorkerSecretUpdateState(
        manifest,
        workerCutoverGeneration,
        'committed',
        workerSecretUpdateIntent.id,
        now(),
      );
    }
    manifest = {
      ...manifest,
      deployment: plan.deployment,
      platformVersion: version,
      runtime: runtimeProvenance,
      safetyProtocols: runtime.safetyProtocols ?? { sandboxDrain: 0 },
      updatedAt: now(),
      usageProtocolVersion: targetUsageProtocolVersion,
    };
    manifest = transitionInstallation(manifest, 'installed', now());
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    workerTrafficGuarded = false;
    writePendingInstallationSecrets(manifest, secretCheckpoint(secrets));
    promoteInstallationSecrets(manifest);
    saveInstalledPlatformConnection(plan, manifest);
    return {
      manifest,
      ...(emailOperationId ? { emailOperationId } : {}),
      setupPending,
      waitingForDns: false,
      waitingForSandboxDrain: false,
      zoneNameServers: zone?.nameServers ?? [],
    };
  } catch (error) {
    throw await recoverFailedPlatformInstallation(
      error,
      manifest,
      plan,
      dependencies,
      workerTrafficGuarded,
      workerDeploymentCommitted,
      workerRollbacks,
      authenticationEnforcementActive,
      authenticationProtocolTransition,
      workerCutoverGeneration,
      previousPublicEndpoints,
      now,
      writeRemoteInstallationCheckpoint,
    );
  } finally {
    await releaseDatabaseLock();
  }
}

function checkpointAuthenticationResources(
  manifest: PlatformInstallationManifest,
  secrets: PlatformInstallationSecrets,
  updatedAt: string,
): PlatformInstallationManifest {
  return checkpointPlatformAccessResources(manifest, secrets.accessProvisioningJson, updatedAt);
}

async function writeR2OwnershipMarkerIfNeeded(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): Promise<void> {
  if (action.kind !== 'r2-bucket') {
    return;
  }
  const bucket = manifest.resources.find(
    (resource) => resource.key === action.key && resource.state === 'ready',
  );
  if (!bucket || bucket.ownership !== 'created') {
    return;
  }
  await client.putR2Object(
    plan.account.id,
    bucket.name,
    PLATFORM_R2_OWNERSHIP_MARKER_KEY,
    JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: plan.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: bucket.id,
        resourceKey: bucket.key,
        resourceKind: bucket.kind,
        resourceName: bucket.name,
      }),
    ),
  );
}

function saveInstalledPlatformConnection(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
): void {
  savePlatformConnection({
    accountId: plan.account.id,
    apiUrl: plan.apiUrl,
    applicationDomain: plan.deployment.application.baseDomain,
    displayName: plan.deployment.displayName,
    installationId: manifest.id,
    kind: 'installed',
    proxyUrl: plan.proxyUrl,
  });
}

async function writeRemoteInstallationCheckpointWithoutDatabase(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  databaseLock?: PlatformDatabaseLifecycleLock,
): Promise<void> {
  const startedAt = performance.now();
  await databaseLock?.checkpoint?.(manifest);
  if (process.env.VOID_PLATFORM_TIMINGS === '1') {
    process.stderr.write(
      `[platform timing] database checkpoint ${(performance.now() - startedAt).toFixed(0)} ms\n`,
    );
  }
  const routing = manifest.resources.find(
    (resource) =>
      resource.key === 'routing-kv' &&
      resource.kind === 'kv-namespace' &&
      resource.ownership === 'created' &&
      resource.state === 'ready',
  );
  if (!routing) {
    return;
  }
  const kvStartedAt = performance.now();
  await client.putKvValue(
    plan.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
    JSON.stringify(manifest),
  );
  if (process.env.VOID_PLATFORM_TIMINGS === '1') {
    process.stderr.write(
      `[platform timing] remote checkpoint ${(performance.now() - kvStartedAt).toFixed(0)} ms\n`,
    );
  }
}

function recordProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  const resultHash = platformProvisionIntentHash(
    manifest,
    action.key,
    action.kind,
    action.name,
    previousResourceId,
  );
  const existing = manifest.steps.find(
    (step) =>
      (step.key === `provision-intent:${action.key}` ||
        step.key.startsWith(`provision-intent:${action.key}:`)) &&
      step.resultHash === resultHash,
  );
  if (existing) {
    return manifest;
  }
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `provision-intent:${action.key}:${resultHash.slice(0, 16)}`,
      resultHash,
    },
    now,
  );
}

function recordAdoptionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  now: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `adoption-intent:${action.key}`,
      resultHash: platformAdoptionIntentHash(manifest, action.key, action.kind, id, action.name),
    },
    now,
  );
}

function hasProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): boolean {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  return manifest.steps.some(
    (step) =>
      (step.key === `provision-intent:${action.key}` ||
        step.key.startsWith(`provision-intent:${action.key}:`)) &&
      step.resultHash ===
        platformProvisionIntentHash(
          manifest,
          action.key,
          action.kind,
          action.name,
          previousResourceId,
        ),
  );
}

async function createResource(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  action: PlatformInstallPlanAction,
  databaseUrl: string,
  zoneId: string,
): Promise<CloudflareNamedResource> {
  switch (action.kind) {
    case 'ai-gateway':
      return client.createAiGateway(plan.account.id, action.name);
    case 'dns-record':
      return client.createDnsRecord(zoneId, action.name);
    case 'kv-namespace':
      return client.createKvNamespace(plan.account.id, action.name);
    case 'r2-bucket':
      return client.createR2Bucket(plan.account.id, action.name);
    case 'queue':
      return client.createQueue(plan.account.id, action.name);
    case 'dispatch-namespace':
      return client.createDispatchNamespace(plan.account.id, action.name);
    case 'hyperdrive':
      return client.createHyperdrive(plan.account.id, action.name, databaseUrl);
    default:
      throw new Error(`platform: Cannot provision ${action.kind} in the resource phase.`);
  }
}

export function recordResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  ownership: InstallationResource['ownership'] | undefined,
  now: string,
  databaseUrl?: string,
  resourceFingerprint?: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  return recordInstallationResource(
    manifest,
    {
      configHash:
        action.kind === 'dns-record'
          ? dnsRecordConfigHash(action.name, 'AAAA', '100::', true)
          : action.kind === 'hyperdrive' && resourceFingerprint
            ? resourceFingerprint
            : action.kind === 'hyperdrive' && databaseUrl
              ? hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(databaseUrl))
              : action.kind === 'r2-bucket' && resourceFingerprint
                ? r2BucketConfigHash(action.name, resourceFingerprint)
                : hash(JSON.stringify({ kind: action.kind, name: action.name })),
      id,
      key: action.key,
      kind: action.kind,
      name: action.name,
      ownership: ownership ?? previous?.ownership ?? 'created',
      state: 'ready',
    },
    now,
  );
}

export function r2BucketConfigHash(name: string, fingerprint: string): string {
  return hash(JSON.stringify({ fingerprint, kind: 'r2-bucket', name }));
}

export function retainReplacedInstallationResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  if (
    action.action !== 'create' ||
    !previous ||
    previous.state !== 'ready' ||
    previous.name === action.name
  ) {
    return manifest;
  }
  const retainedKey = `retained:${action.key}:${hash(previous.id).slice(0, 16)}`;
  const resources = manifest.resources
    .filter((resource) => resource.key !== action.key && resource.key !== retainedKey)
    .concat({ ...previous, key: retainedKey, state: 'retained' as const })
    .sort((left, right) => left.key.localeCompare(right.key));
  return { ...manifest, resources, updatedAt: now };
}

function validateReplannedWorkerActions(
  original: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  actions: ReadonlyArray<PlatformInstallPlanAction>,
): ReadonlyArray<PlatformInstallPlanAction> {
  const expected = original.actions.filter((action) => action.kind === 'worker');
  if (actions.length !== expected.length) {
    throw new Error('platform: Fresh Cloudflare planning did not return every platform Worker.');
  }
  for (const previous of expected) {
    const matches = actions.filter((action) => action.key === previous.key);
    const current = matches[0];
    if (
      matches.length !== 1 ||
      !current ||
      current.kind !== 'worker' ||
      current.name !== previous.name
    ) {
      throw new Error(
        `platform: Fresh Cloudflare planning changed the identity of Worker ${JSON.stringify(previous.name)}.`,
      );
    }
    const resource = manifest.resources.find((entry) => entry.key === current.key);
    if (resource?.state === 'deleted' && current.action !== 'create') {
      throw new Error(
        `platform: Fresh Cloudflare planning did not recreate deleted Worker ${JSON.stringify(current.name)}.`,
      );
    }
  }
  return actions;
}

export async function inventoryUnmanagedPlatformWorkerTraffic(
  client: Pick<InstallerClient, 'listWorkerDomains' | 'listWorkerServiceRoutes'>,
  plan: PlatformInstallPlan,
  workerName: string,
): Promise<ReadonlyArray<unknown>> {
  if (!client.listWorkerDomains || !client.listWorkerServiceRoutes) {
    throw new Error(
      `platform: Cloudflare traffic inventory is required before updating Worker ${JSON.stringify(workerName)}.`,
    );
  }
  const [routes, domains] = await Promise.all([
    client.listWorkerServiceRoutes(plan.account.id, workerName),
    client.listWorkerDomains(plan.account.id),
  ]);
  const managed = platformManagedWorkerTraffic(plan.deployment, new Set([workerName]));
  const managedRoutes = new Set(managed.routes.map((route) => route.pattern));
  const managedDomains = new Set(managed.customDomains.map((domain) => domain.hostname));
  return uniqueTriggerRoutes([
    ...routes
      .filter((route) => !managedRoutes.has(route.pattern))
      .map((route) => ({ pattern: route.pattern, zone_name: route.zoneName })),
    ...domains
      .filter((domain) => domain.service === workerName && !managedDomains.has(domain.hostname))
      .map((domain) => ({
        pattern: domain.hostname,
        custom_domain: true,
        ...(domain.zoneName ? { zone_name: domain.zoneName } : {}),
      })),
  ]);
}

export function mergePlatformWorkerTrafficConfig(
  config: Record<string, unknown>,
  preservedRoutes: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (preservedRoutes.length === 0) {
    return config;
  }
  return {
    ...config,
    routes: uniqueTriggerRoutes([
      ...(Array.isArray(config.routes) ? config.routes : []),
      ...preservedRoutes,
    ]),
  };
}

export function mergePreservedTriggerRoutes(
  config: CloudflareTriggerConfig,
  preservedRoutes: ReadonlyArray<unknown>,
): CloudflareTriggerConfig {
  return preservedRoutes.length === 0
    ? config
    : { ...config, routes: uniqueTriggerRoutes([...config.routes, ...preservedRoutes]) };
}

export function isolatePlatformWorkerCustomDomains(config: Record<string, unknown>): {
  customDomains: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>;
  wranglerConfig: Record<string, unknown>;
} {
  if (config.routes === undefined) {
    return { customDomains: [], wranglerConfig: config };
  }
  if (!Array.isArray(config.routes)) {
    throw new Error('platform: Generated Worker routes must be an array.');
  }
  const customDomains: Array<CloudflareWorkerCustomDomainOrigin> = [];
  const wranglerRoutes: Array<unknown> = [];
  for (const route of config.routes) {
    if (
      typeof route !== 'object' ||
      route === null ||
      (route as Record<string, unknown>).custom_domain !== true
    ) {
      wranglerRoutes.push(route);
      continue;
    }
    const entry = route as Record<string, unknown>;
    const hostname = requiredNonEmptyString(entry.pattern, 'Worker Custom Domain hostname');
    customDomains.push({
      hostname,
      ...(entry.zone_id === undefined
        ? {}
        : { zoneId: requiredNonEmptyString(entry.zone_id, `zone id for ${hostname}`) }),
      ...(entry.zone_name === undefined
        ? {}
        : { zoneName: requiredNonEmptyString(entry.zone_name, `zone name for ${hostname}`) }),
      ...(entry.enabled === undefined
        ? {}
        : { enabled: requiredBoolean(entry.enabled, `enabled for ${hostname}`) }),
      ...(entry.previews_enabled === undefined
        ? {}
        : {
            previewsEnabled: requiredBoolean(
              entry.previews_enabled,
              `previews_enabled for ${hostname}`,
            ),
          }),
    });
  }
  return {
    customDomains,
    wranglerConfig: { ...config, routes: wranglerRoutes },
  };
}

export function withoutPlatformWorkerTrafficAttachments(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const isolated = { ...config };
  delete isolated.route;
  delete isolated.routes;
  return isolated;
}

function withoutPlatformCustomDomainTriggers(
  config: CloudflareTriggerConfig,
): CloudflareTriggerConfig {
  return {
    ...config,
    routes: config.routes.filter(
      (route) =>
        typeof route !== 'object' ||
        route === null ||
        (route as Record<string, unknown>).custom_domain !== true,
    ),
  };
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`platform: ${field} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`platform: ${field} must be a boolean.`);
  }
  return value;
}

async function publishPlatformWorkerCustomDomains(
  client: InstallerClient,
  accountId: string,
  workerName: string,
  origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
): Promise<void> {
  if (!client.publishWorkerCustomDomainsSafely) {
    throw new Error('platform: Safe Cloudflare Custom Domain publication is unavailable.');
  }
  await client.publishWorkerCustomDomainsSafely(accountId, workerName, origins);
}

function uniqueTriggerRoutes(routes: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = JSON.stringify(route);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dnsRecordConfigHash(
  name: string,
  type: string,
  content: string,
  proxied: boolean,
): string {
  return hash(JSON.stringify({ content, kind: 'dns-record', name, proxied, type }));
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function databaseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function requireId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (!id) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return id;
}

export function apiWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
): Record<string, string> {
  return withoutEmptySecrets({
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    CF_ZONE_ID: zoneId,
    GITHUB_CLIENT_ID: secrets.githubClientId,
    GITHUB_CLIENT_SECRET: secrets.githubClientSecret,
    ...(secrets.emailEnabled ? { EMAIL_SIGNING_SECRET: secrets.emailSigningSecret } : {}),
    JWT_SECRET: secrets.jwtSecret,
    PLATFORM_BOOTSTRAP_GITHUB_ID: secrets.bootstrapGitHubId,
    PLATFORM_AUTH_SETUP_TOKEN: secrets.authSetupToken ?? '',
    ...(secrets.projectSecretKeysJson && secrets.projectSecretActiveKeyVersion
      ? {
          PROJECT_SECRET_ACTIVE_KEY_VERSION: secrets.projectSecretActiveKeyVersion,
          PROJECT_SECRET_KEYS_JSON: secrets.projectSecretKeysJson,
        }
      : {}),
    R2_ACCESS_KEY_ID: secrets.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: secrets.r2SecretAccessKey,
  });
}

/** Existing Workers inherit live secrets, including complete encryption keyrings. */
export function platformWorkerSecretPayload(
  worker: 'api' | 'proxy' | 'emailGateway' | 'tail' | 'dispatch',
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
  existingWorker: boolean,
): Record<string, string> | null {
  if (worker !== 'api' && worker !== 'proxy' && worker !== 'emailGateway') {
    return null;
  }
  if (!existingWorker) {
    if (worker === 'api') {
      return apiWorkerSecrets(secrets, accountId, zoneId);
    }
    if (worker === 'emailGateway') {
      const payload = withoutEmptySecrets({
        EMAIL_SIGNING_SECRET: secrets.emailEnabled ? secrets.emailSigningSecret : '',
      });
      return Object.keys(payload).length > 0 ? payload : null;
    }
    return proxyWorkerSecrets(secrets, accountId);
  }
  const allowed =
    worker === 'api'
      ? [
          'CF_API_TOKEN',
          'EMAIL_SIGNING_SECRET',
          'GITHUB_CLIENT_ID',
          'GITHUB_CLIENT_SECRET',
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
        ]
      : worker === 'proxy'
        ? ['CF_API_TOKEN', 'EMAIL_SIGNING_SECRET']
        : ['EMAIL_SIGNING_SECRET'];
  const updates = Object.fromEntries(
    Object.entries(secrets.workerSecretUpdates ?? {}).filter(
      ([name, value]) => allowed.includes(name) && typeof value === 'string' && value !== '',
    ),
  );
  return Object.keys(updates).length > 0 ? updates : null;
}

export async function resolveBootstrapGitHubId(
  login: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const normalizedLogin = login.trim();
  if (!normalizedLogin) {
    throw new Error('platform: VOID_PLATFORM_ADMIN_GITHUB_LOGIN is required.');
  }
  const response = await fetcher(
    `https://api.github.com/users/${encodeURIComponent(normalizedLogin)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-platform-installer',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `platform: Could not resolve GitHub user ${JSON.stringify(normalizedLogin)} (HTTP ${response.status}). Verify the username and retry.`,
    );
  }
  const body = (await response.json()) as { id?: unknown };
  const id = typeof body.id === 'number' && Number.isSafeInteger(body.id) ? String(body.id) : '';
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(
      'platform: GitHub returned an invalid account id for the initial administrator.',
    );
  }
  return id;
}

function proxyWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
): Record<string, string> {
  return withoutEmptySecrets({
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    ...(secrets.emailEnabled ? { EMAIL_SIGNING_SECRET: secrets.emailSigningSecret } : {}),
    JWT_SECRET: secrets.jwtSecret,
  });
}

function withoutEmptySecrets(secrets: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ''));
}

export function assertRequiredPlatformSecrets(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  secrets: PlatformInstallationSecrets,
  authenticationWillBePrepared = false,
): void {
  const missing = new Set<string>();
  const requireSecret = (value: string, name: string) => {
    if (!value) {
      missing.add(name);
    }
  };
  if (
    plan.deployment.authentication.configurable &&
    !manifest.steps.some((step) => step.key.startsWith('authentication-initialized:v1:')) &&
    !(
      manifest.deployment.authentication.configurable &&
      manifest.steps.some((step) => step.key === 'bootstrap-access:v1')
    )
  ) {
    if (!authenticationWillBePrepared) {
      requireSecret(secrets.authenticationSetupJson ?? '', 'authentication setup configuration');
    }
    requireSecret(secrets.authSetupToken ?? '', 'installation authentication setup authority');
    requireSecret(secrets.authBootstrapCode ?? '', 'administrator setup code');
  } else if (
    !plan.deployment.authentication.configurable &&
    !manifest.steps.some((step) => step.key === 'bootstrap-access:v1')
  ) {
    requireSecret(secrets.bootstrapGitHubId, 'VOID_PLATFORM_ADMIN_GITHUB_ID');
    requireSecret(secrets.bootstrapGitHubLogin, 'VOID_PLATFORM_ADMIN_GITHUB_LOGIN');
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'api-worker' && action.kind === 'worker' && action.action === 'create',
    )
  ) {
    requireSecret(secrets.cloudflareApiToken, 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
    if (!plan.deployment.authentication.configurable) {
      requireSecret(secrets.githubClientId, 'VOID_PLATFORM_GITHUB_CLIENT_ID');
      requireSecret(secrets.githubClientSecret, 'VOID_PLATFORM_GITHUB_CLIENT_SECRET');
    }
    requireSecret(secrets.jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
    requireSecret(
      secrets.projectSecretKeysJson,
      'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON (or VOID_PLATFORM_PROJECT_SECRET_KEY for v1)',
    );
    requireSecret(
      secrets.projectSecretActiveKeyVersion,
      'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION (or VOID_PLATFORM_PROJECT_SECRET_KEY for v1)',
    );
    requireSecret(secrets.r2AccessKeyId, 'VOID_PLATFORM_R2_ACCESS_KEY_ID');
    requireSecret(secrets.r2SecretAccessKey, 'VOID_PLATFORM_R2_SECRET_ACCESS_KEY');
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'proxy-worker' && action.kind === 'worker' && action.action === 'create',
    )
  ) {
    requireSecret(secrets.cloudflareApiToken, 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
    requireSecret(secrets.jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
  }
  if (
    plan.actions.some(
      (action) =>
        action.key === 'email-gateway-worker' &&
        action.kind === 'worker' &&
        action.action === 'create',
    )
  ) {
    if (plan.deployment.capabilities.email) {
      requireSecret(secrets.emailSigningSecret, 'VOID_PLATFORM_EMAIL_SIGNING_SECRET');
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `platform: Creating a missing platform Worker requires: ${[...missing].sort().join(', ')}. Restore these values from your secret manager and retry.`,
    );
  }
}

/**
 * A Hyperdrive that Void creates validates the server against public certificate authorities
 * only, so it cannot honor a private CA that the local database client would trust.
 */
function assertVoidCreatedHyperdriveTrustsDatabase(databaseUrl: string): void {
  // Same last-value-wins rule as the local client; pg ignores an empty value.
  const sslrootcert = new URL(databaseUrl).searchParams.getAll('sslrootcert').at(-1);
  if (sslrootcert && sslrootcert !== 'system') {
    throw new Error(
      'platform: A Hyperdrive created by Void trusts only public certificate authorities, so it cannot use the certificate authority in DATABASE_URL sslrootcert. If the database certificate comes from a public certificate authority, use sslrootcert=system. Otherwise create a separately managed Hyperdrive that trusts it, then select it with "Use an existing Hyperdrive" when you start a new installation, or set VOID_PLATFORM_HYPERDRIVE_ID, VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST, and VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER.',
    );
  }
}

/** Make pg's current strict TLS behavior explicit without rewriting saved connection details. */
export function platformDatabaseClientUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return databaseUrl;
  }
  // Match pg's last-value-wins query parsing. libpq reads `sslrootcert=system` as the system
  // trust store and requires verify-full with it, while pg would open it as a file path. Node's
  // default CAs with hostname verification give pg the same policy.
  if (url.searchParams.getAll('sslrootcert').at(-1) === 'system') {
    url.searchParams.delete('sslrootcert');
    url.searchParams.set('sslmode', 'verify-full');
    return url.toString();
  }
  // Respect explicit libpq compatibility.
  if (
    url.searchParams.getAll('sslmode').at(-1) !== 'require' ||
    url.searchParams.getAll('uselibpqcompat').at(-1) === 'true'
  ) {
    return databaseUrl;
  }
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

export async function claimPlatformDatabase(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  const client = await pool.connect();
  try {
    await claimPlatformDatabaseConnection(client, installationId, ownershipNonce);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function acquirePlatformDatabaseLifecycleLock(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  const client = await pool.connect();
  try {
    const releaseConnectionLock = await acquirePlatformDatabaseLifecycleLockConnection(
      client,
      installationId,
      ownershipNonce,
    );
    const release: PlatformDatabaseLifecycleLock = async () => {
      try {
        await releaseConnectionLock();
      } finally {
        client.release();
        await pool.end();
      }
    };
    // Keep the complete session-lock contract when adding pool cleanup. Safety
    // and verification hooks must not disappear at this wrapper boundary.
    return Object.assign(release, releaseConnectionLock);
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
}

export async function readPlatformDatabaseLifecycleManifest(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  try {
    return await readPlatformDatabaseLifecycleManifestConnection(
      pool,
      installationId,
      ownershipNonce,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('platform:')) {
      throw error;
    }
    throw new Error(
      `platform: Could not read the PostgreSQL lifecycle checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await pool.end();
  }
}

type DatabaseClaimConnection = Readonly<{
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: ReadonlyArray<Row> }>;
}>;

type PlatformDatabaseMigrationRow = Readonly<{
  created_at: unknown;
  hash: unknown;
  id: unknown;
}>;

export async function inspectPlatformDatabaseStateConnection(
  client: DatabaseClaimConnection,
  database: PlatformRuntimeDatabaseManifest,
): Promise<PlatformDatabaseState> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"drizzle"."__drizzle_migrations"')::text AS "relation"`,
  );
  if (relation.rows.length === 0 || relation.rows[0]?.relation === null) {
    return {
      pendingMigrations: database.migrations,
      schemaDigest: platformDatabaseSchemaDigest(database.lineage, []),
    };
  }
  const result = await client.query<PlatformDatabaseMigrationRow>(
    `SELECT "id", "hash", "created_at"
     FROM "drizzle"."__drizzle_migrations"
     ORDER BY "created_at", "id"`,
  );
  if (result.rows.length > database.migrations.length) {
    throw new Error(
      'platform: PostgreSQL contains migrations newer than this Void Platform package.',
    );
  }
  let previousTimestamp = -1;
  const seenTimestamps = new Set<number>();
  for (const [position, row] of result.rows.entries()) {
    const timestampMillis = databaseInteger(row.created_at);
    if (
      timestampMillis === null ||
      timestampMillis <= previousTimestamp ||
      seenTimestamps.has(timestampMillis)
    ) {
      throw new Error(
        'platform: PostgreSQL migration history is duplicated or not strictly ordered.',
      );
    }
    const expected = database.migrations[position];
    if (!expected || timestampMillis !== expected.timestampMillis || row.hash !== expected.sha256) {
      throw new Error(
        'platform: PostgreSQL migration history is not an exact prefix of this Void Platform package. Refusing to apply edited, forked, or out-of-order migrations.',
      );
    }
    previousTimestamp = timestampMillis;
    seenTimestamps.add(timestampMillis);
  }
  const applied = database.migrations.slice(0, result.rows.length);
  return {
    pendingMigrations: database.migrations.slice(result.rows.length),
    schemaDigest: platformDatabaseSchemaDigest(database.lineage, applied),
  };
}

export async function preparePlatformDatabaseConnection(
  client: DatabaseClaimConnection,
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
  sourcePlatformVersion: string | null,
  hasPriorWorkers: boolean,
): Promise<PlatformDatabaseMigrationResult> {
  verifyPlatformDatabaseArtifacts(runtimeDirectory, database);
  const before = await inspectPlatformDatabaseStateConnection(client, database);
  if (before.pendingMigrations.length === 0) {
    if (before.schemaDigest !== database.schemaDigest) {
      throw new Error('platform: PostgreSQL schema digest does not match the packaged runtime.');
    }
    return {
      appliedMigrations: 0,
      previousSchemaDigest: before.schemaDigest,
      schemaDigest: before.schemaDigest,
    };
  }
  if (
    hasPriorWorkers &&
    !database.rollbackSafeFrom.some(
      (entry) =>
        entry.platformVersion === sourcePlatformVersion &&
        entry.schemaDigest === before.schemaDigest,
    )
  ) {
    throw new Error(
      `platform: Void Platform ${sourcePlatformVersion ?? 'unknown'} cannot safely roll back after migrating database schema ${before.schemaDigest} to this release. Upgrade through a supported intermediate version or install into a fresh database.`,
    );
  }

  await client.query('BEGIN');
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        "id" serial PRIMARY KEY,
        "hash" text NOT NULL,
        "created_at" bigint
      )
    `);
    const rechecked = await inspectPlatformDatabaseStateConnection(client, database);
    if (rechecked.schemaDigest !== before.schemaDigest) {
      throw new Error(
        'platform: PostgreSQL migration history changed while preparing this upgrade.',
      );
    }
    for (const migration of rechecked.pendingMigrations) {
      const sql = readFileSync(join(runtimeDirectory, 'drizzle', `${migration.tag}.sql`), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
         VALUES ($1, $2)`,
        [migration.sha256, migration.timestampMillis],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => ({ rows: [] }));
    throw error;
  }
  const after = await inspectPlatformDatabaseStateConnection(client, database);
  if (after.pendingMigrations.length !== 0 || after.schemaDigest !== database.schemaDigest) {
    throw new Error(
      'platform: PostgreSQL migration transaction completed without reaching the packaged schema.',
    );
  }
  return {
    appliedMigrations: before.pendingMigrations.length,
    previousSchemaDigest: before.schemaDigest,
    schemaDigest: after.schemaDigest,
  };
}

export async function readPlatformDatabaseLifecycleManifestConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"__void_platform_installation"')::text AS "relation"`,
  );
  if (relation.rows[0]?.relation === null || relation.rows.length === 0) {
    return null;
  }
  const result = await client.query<{
    installation_id: string;
    lifecycle_manifest: unknown;
    ownership_nonce: string;
  }>(
    `SELECT "installation_id", "ownership_nonce", "lifecycle_manifest"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.installation_id !== installationId ||
    row.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  if (row.lifecycle_manifest === null || row.lifecycle_manifest === undefined) {
    return null;
  }
  const manifest = parsePlatformInstallationManifest(row.lifecycle_manifest);
  if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
    throw new Error(
      'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
    );
  }
  return manifest;
}

export async function acquirePlatformDatabaseLifecycleLockConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  await client.query(
    `ALTER TABLE "__void_platform_installation"
     ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
  );
  const claim = await client.query<{ installation_id: string; ownership_nonce: string }>(
    `SELECT "installation_id", "ownership_nonce"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const owner = claim.rows[0];
  if (
    !owner ||
    owner.installation_id !== installationId ||
    owner.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  const lockIdentity = `void-platform-lifecycle-v1:${installationId}:${ownershipNonce}`;
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "acquired"',
    [lockIdentity],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error(
      `platform: Another lifecycle operation is active for installation ${installationId} on another host.`,
    );
  }
  let authoritativeManifest: PlatformInstallationManifest | null = null;
  try {
    const checkpoint = await client.query<{ lifecycle_manifest: unknown }>(
      `SELECT "lifecycle_manifest"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
         AND "installation_id" = $1
         AND "ownership_nonce" = $2`,
      [installationId, ownershipNonce],
    );
    const value = checkpoint.rows[0]?.lifecycle_manifest;
    if (checkpoint.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    if (value !== null && value !== undefined) {
      authoritativeManifest = parsePlatformInstallationManifest(value);
      if (
        authoritativeManifest.id !== installationId ||
        authoritativeManifest.ownershipNonce !== ownershipNonce
      ) {
        throw new Error(
          'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
        );
      }
    }
  } catch (error) {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    if (error instanceof Error && error.message.startsWith('platform:')) {
      throw error;
    }
    throw new Error(
      `platform: The PostgreSQL lifecycle checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let released = false;
  const release: PlatformDatabaseLifecycleLock = async () => {
    if (released) {
      return;
    }
    released = true;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
  };
  release.authoritativeManifest = authoritativeManifest;
  release.readAuthenticationState = async () => {
    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.platform_auth_settings') IS NOT NULL AS present",
    );
    if (!table.rows[0]?.present) {
      return null;
    }
    const [result, enabledProviders] = await Promise.all([
      client.query<{ sessions_required: boolean; protection: unknown }>(
        'SELECT sessions_required, protection FROM platform_auth_settings WHERE singleton = true',
      ),
      client.query<{ kind: PlatformLoginKind }>(
        'SELECT DISTINCT kind FROM platform_login_connections WHERE enabled = true ORDER BY kind',
      ),
    ]);
    const settings = result.rows[0];
    return settings
      ? {
          enabledProviders: enabledProviders.rows.map((row) => row.kind),
          sessionsRequired: settings.sessions_required,
          protectedByAccess: settings.protection !== null,
          protection: parsePlatformAccessProtection(settings.protection),
        }
      : null;
  };
  release.requiredSafetyProtocols = await readRequiredPlatformSafetyProtocols(client);
  release.checkpoint = async (manifest) => {
    if (released) {
      throw new Error('platform: Cannot checkpoint lifecycle state after releasing its lock.');
    }
    if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
      throw new Error('platform: Refusing to checkpoint lifecycle state for another installation.');
    }
    const updated = await client.query<{ singleton: boolean }>(
      `UPDATE "__void_platform_installation"
       SET "lifecycle_manifest" = $1::jsonb
       WHERE "singleton" = true
         AND "installation_id" = $2
         AND "ownership_nonce" = $3
       RETURNING "singleton"`,
      [JSON.stringify(manifest), installationId, ownershipNonce],
    );
    if (updated.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    release.authoritativeManifest = manifest;
  };
  release.prepareDatabase = (runtimeDirectory, database, sourcePlatformVersion, hasPriorWorkers) =>
    preparePlatformDatabaseConnection(
      client,
      runtimeDirectory,
      database,
      sourcePlatformVersion,
      hasPriorWorkers,
    );
  release.prepareSandboxDrain = (requiredAdmissionProtocol) =>
    preparePlatformSandboxDrainConnection(client, requiredAdmissionProtocol);
  release.verifyDatabase = (runtimeDirectory, database) =>
    verifyPlatformDatabaseConnection(client, runtimeDirectory, database);
  return release;
}

export async function preparePlatformSandboxDrainConnection(
  client: DatabaseClaimConnection,
  requiredAdmissionProtocol: 0 | 2 | 3 = 0,
): Promise<PlatformSandboxDrainPreparation> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"sandbox_drain_checkpoints"')::text AS "relation"`,
  );
  if (!relation.rows[0]?.relation) {
    throw new Error(
      'platform: Runtime declares sandbox-drain safety but its database checkpoint table is missing.',
    );
  }
  const admissionColumn = await client.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'sandbox_drain_checkpoints'
         AND column_name = 'admission_protocol'
     ) AS "present"`,
  );
  const hasAdmissionColumn = admissionColumn.rows[0]?.present === true;
  if (requiredAdmissionProtocol >= 2 && !hasAdmissionColumn) {
    throw new Error(
      'platform: The runtime database does not include the sandbox deployment admission barrier.',
    );
  }
  const readCheckpoint = () =>
    client.query<{
      admission_protocol: number;
      completed_at: string | null;
      cursor: unknown;
      generation: string;
      phase: string;
      started_at: string;
      state: string;
      updated_at: string;
    }>(
      `SELECT ${hasAdmissionColumn ? '"admission_protocol"' : '0 AS "admission_protocol"'}, "generation", "state", "phase", "cursor", "started_at", "updated_at", "completed_at"
       FROM "sandbox_drain_checkpoints"
       WHERE "singleton" = true`,
    );
  const classify = (
    row:
      | {
          admission_protocol: number;
          completed_at: string | null;
          cursor: unknown;
          generation: string;
          phase: string;
          started_at: string;
          state: string;
          updated_at: string;
        }
      | undefined,
  ): PlatformSandboxDrainPreparation | null => {
    if (!row) {
      return null;
    }
    const cursor = row.cursor as Record<string, unknown> | null;
    if (
      !row.generation ||
      (row.admission_protocol !== 0 &&
        row.admission_protocol !== 2 &&
        row.admission_protocol !== 3) ||
      !row.started_at ||
      !row.updated_at ||
      (row.state !== 'draining' && row.state !== 'complete') ||
      (row.phase !== 'deployments' && row.phase !== 'resources') ||
      !cursor ||
      (cursor.pass !== '1' && cursor.pass !== '2') ||
      (row.state === 'complete' &&
        (!row.completed_at || row.phase !== 'resources' || cursor.pass !== '2')) ||
      (row.state === 'draining' && row.completed_at !== null)
    ) {
      throw new Error(
        'platform: The authoritative sandbox-drain database checkpoint is invalid. Traffic remains disabled.',
      );
    }
    return {
      admissionProtocol: row.admission_protocol,
      generation: row.generation,
      mirrorValue: JSON.stringify({
        version: 1,
        generation: row.generation,
        state: row.state,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      }),
      state: row.state === 'complete' ? 'complete' : 'pending',
    };
  };
  const existing = await readCheckpoint();
  const existingState = classify(existing.rows[0]);
  if (
    existingState &&
    (requiredAdmissionProtocol === 0 ||
      existingState.admissionProtocol >= requiredAdmissionProtocol)
  ) {
    return existingState;
  }
  if (requiredAdmissionProtocol >= 2) {
    // Protocol 2 already drained tenant-owned containers. Advancing authority
    // must not restart that drain against the new platform-owned controllers.
    if (existingState && existingState.admissionProtocol >= 2) {
      await client.query('BEGIN');
      try {
        await client.query('LOCK TABLE "deployments" IN SHARE MODE');
        await client.query(
          `UPDATE "sandbox_drain_checkpoints"
           SET "admission_protocol" = GREATEST("admission_protocol", $1), "updated_at" = now()
           WHERE "singleton" = true`,
          [requiredAdmissionProtocol],
        );
        const advanced = classify((await readCheckpoint()).rows[0]);
        if (!advanced || advanced.admissionProtocol < requiredAdmissionProtocol) {
          throw new Error('platform: The Sandbox controller admission barrier could not be armed.');
        }
        await client.query('COMMIT');
        return advanced;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    const generation = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('LOCK TABLE "deployments" IN SHARE MODE');
      await client.query(
        `INSERT INTO "sandbox_drain_checkpoints" (
           "singleton", "admission_protocol", "generation", "state", "phase", "cursor"
         ) VALUES (true, 2, $1, 'draining', 'deployments', '{"pass":"1"}'::jsonb)
         ON CONFLICT ("singleton") DO UPDATE
         SET "admission_protocol" = 2,
             "generation" = EXCLUDED."generation",
             "state" = 'draining',
             "phase" = 'deployments',
             "cursor" = '{"pass":"1"}'::jsonb,
             "lease_owner" = NULL,
             "lease_expires_at" = NULL,
             "started_at" = now(),
             "updated_at" = now(),
             "completed_at" = NULL`,
        [generation],
      );
      const inventory = await client.query<{ empty: boolean }>(
        `SELECT
           NOT EXISTS(SELECT 1 FROM "deployments" LIMIT 1)
           AND NOT EXISTS(SELECT 1 FROM "resources" WHERE "type" = 'container' LIMIT 1)
           AS "empty"`,
      );
      if (inventory.rows[0]?.empty === true) {
        await client.query(
          `UPDATE "sandbox_drain_checkpoints"
           SET "state" = 'complete',
               "phase" = 'resources',
               "cursor" = '{"pass":"2"}'::jsonb,
               "lease_owner" = NULL,
               "lease_expires_at" = NULL,
               "updated_at" = now(),
               "completed_at" = now()
           WHERE "singleton" = true
             AND "admission_protocol" = 2
             AND "generation" = $1`,
          [generation],
        );
      }
      if (requiredAdmissionProtocol >= 3) {
        await client.query(
          `UPDATE "sandbox_drain_checkpoints" SET "admission_protocol" = $1
           WHERE "singleton" = true`,
          [requiredAdmissionProtocol],
        );
      }
      const armed = classify((await readCheckpoint()).rows[0]);
      if (!armed || armed.admissionProtocol < requiredAdmissionProtocol) {
        throw new Error('platform: The sandbox deployment admission barrier could not be armed.');
      }
      await client.query('COMMIT');
      return armed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  const inventory = await client.query<{ empty: boolean }>(
    `SELECT
       NOT EXISTS(SELECT 1 FROM "deployments" LIMIT 1)
       AND NOT EXISTS(SELECT 1 FROM "resources" WHERE "type" = 'container' LIMIT 1)
       AS "empty"`,
  );
  const empty = inventory.rows[0]?.empty === true;
  const generation = randomUUID();
  const state = empty ? 'complete' : 'draining';
  const phase = empty ? 'resources' : 'deployments';
  const cursor = JSON.stringify({ pass: empty ? '2' : '1' });
  await client.query(
    `INSERT INTO "sandbox_drain_checkpoints" (
       "singleton", "generation", "state", "phase", "cursor", "completed_at"
     ) VALUES (true, $1, $2, $3, $4::jsonb, CASE WHEN $2 = 'complete' THEN now() ELSE NULL END)
     ON CONFLICT ("singleton") DO NOTHING`,
    [generation, state, phase, cursor],
  );
  const checkpoint = await readCheckpoint();
  const preparedState = classify(checkpoint.rows[0]);
  if (!preparedState) {
    throw new Error('platform: The sandbox-drain database checkpoint could not be established.');
  }
  return preparedState;
}

export async function verifyPlatformDatabaseConnection(
  client: DatabaseClaimConnection,
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
): Promise<void> {
  verifyPlatformDatabaseArtifacts(runtimeDirectory, database);
  const state = await inspectPlatformDatabaseStateConnection(client, database);
  if (state.pendingMigrations.length !== 0 || state.schemaDigest !== database.schemaDigest) {
    throw new Error(
      'platform: PostgreSQL is not at the exact forward-only schema recorded by the installed runtime.',
    );
  }
}

async function readRequiredPlatformSafetyProtocols(
  client: DatabaseClaimConnection,
): Promise<Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"sandbox_drain_checkpoints"')::text AS "relation"`,
  );
  if (!relation.rows[0]?.relation) {
    return { sandboxDrain: 0 };
  }
  const admissionColumn = await client.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'sandbox_drain_checkpoints'
         AND column_name = 'admission_protocol'
     ) AS "present"`,
  );
  if (admissionColumn.rows[0]?.present === true) {
    const admission = await client.query<{ required: boolean; protocol: number | null }>(
      `SELECT EXISTS(
         SELECT 1
         FROM "sandbox_drain_checkpoints"
         WHERE "singleton" = true
           AND "admission_protocol" >= 2
       ) AS "required", (SELECT "admission_protocol" FROM "sandbox_drain_checkpoints"
                         WHERE "singleton" = true) AS "protocol"`,
    );
    if (admission.rows[0]?.required === true) {
      if (admission.rows[0].protocol != null && admission.rows[0].protocol > 3) {
        throw new Error('platform: The database requires a newer Sandbox controller protocol.');
      }
      return { sandboxDrain: admission.rows[0].protocol === 3 ? 3 : 2 };
    }
  }
  const checkpoint = await client.query<{ required: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM "sandbox_drain_checkpoints"
       WHERE "singleton" = true
     ) AS "required"`,
  );
  return { sandboxDrain: checkpoint.rows[0]?.required === true ? 1 : 0 };
}

export function assertPlatformRuntimeSafety(
  runtime: Pick<PlatformRuntimeManifest, 'platformVersion' | 'safetyProtocols'>,
  installed: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>,
  database: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }> = { sandboxDrain: 0 },
): void {
  const requiredSandboxDrain = Math.max(
    installed?.sandboxDrain ?? 0,
    database?.sandboxDrain ?? 0,
  ) as 0 | 1 | 2;
  if ((runtime.safetyProtocols?.sandboxDrain ?? 0) < requiredSandboxDrain) {
    throw new Error(
      `platform: Void Platform ${runtime.platformVersion} predates the required sandbox-drain safety protocol. Refusing to upload or activate a runtime that could reopen sandbox creation after drain.`,
    );
  }
}

export async function claimPlatformDatabaseConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('void-platform-installation-ownership-v1'))`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__void_platform_installation" (
        "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
        "installation_id" text NOT NULL,
        "ownership_nonce" text NOT NULL,
        "claimed_at" timestamptz NOT NULL DEFAULT now(),
        "lifecycle_manifest" jsonb
      )
    `);
    await client.query(
      `ALTER TABLE "__void_platform_installation"
       ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
    );
    const result = await client.query<{
      installation_id: string;
      ownership_nonce: string;
    }>(
      `SELECT "installation_id", "ownership_nonce"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
       FOR UPDATE`,
    );
    const claim = result.rows[0];
    if (!claim) {
      const contents = await client.query<{ schemaname: string; tablename: string }>(
        `SELECT "schemaname", "tablename"
         FROM "pg_catalog"."pg_tables"
         WHERE "schemaname" = ANY (current_schemas(false))
           AND "tablename" <> '__void_platform_installation'
         ORDER BY "schemaname", "tablename"
         LIMIT 1`,
      );
      if (contents.rows.length > 0) {
        const table = contents.rows[0]!;
        throw new Error(
          `platform: Refusing to claim a non-empty PostgreSQL database (found ${table.schemaname}.${table.tablename}). Use a dedicated empty database for each installation.`,
        );
      }
      await client.query(
        `INSERT INTO "__void_platform_installation"
           ("singleton", "installation_id", "ownership_nonce")
         VALUES (true, $1, $2)`,
        [installationId, ownershipNonce],
      );
    } else if (
      claim.installation_id !== installationId ||
      claim.ownership_nonce !== ownershipNonce
    ) {
      throw new Error(
        `platform: This PostgreSQL database is already claimed by Void platform installation ${claim.installation_id}. Use a dedicated empty database for each installation.`,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => ({ rows: [] }));
    throw error;
  }
}

type PlatformWorkerDeploymentOptions = Readonly<{
  apiBaseUrl: string;
  readCloudflare?: (path: string) => Promise<unknown>;
  acquireUploadSlot?: () => Promise<(failure?: unknown) => void>;
  onReadyForActivation?: () => Promise<void>;
  waitForPriorWorker?: () => Promise<void>;
  inspectNewWorker: () => Promise<'missing' | 'owned'>;
  onStaged: (
    previousVersionId: string | null,
    stagedVersionId: string,
    previousTriggers: CloudflareTriggerConfig,
  ) => Promise<void>;
  onTrafficPublished: () => Promise<void>;
  onUnsafeTraffic: () => Promise<void>;
  managedRoutes: ReadonlyArray<string>;
  previousConfig: Record<string, unknown>;
  previousPublicEndpoints: boolean;
  preservedRoutes: ReadonlyArray<unknown>;
  publishCustomDomains: (
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ) => Promise<void>;
  publishRoutes: (workerName: string, patterns: ReadonlyArray<string>) => Promise<void>;
  removeCustomDomains: () => Promise<void>;
  retainNewWorker: () => Promise<void>;
  /** False uploads a new version even when the active one has identical input. */
  reuseMatchingVersion?: boolean;
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
}>;

let cachedPlatformUploaderHash: string | null | undefined;

function platformWorkerUploaderHash(): string | null {
  if (cachedPlatformUploaderHash !== undefined) {
    return cachedPlatformUploaderHash;
  }
  try {
    const launcher = resolveWranglerArgv(process.cwd())[1];
    if (!launcher) {
      return (cachedPlatformUploaderHash = null);
    }
    const digest = createHash('sha256');
    digest.update('platform-uploader:v1\0');
    digest.update(process.version);
    digest.update(readFileSync(resolve(dirname(launcher), '..', '..', 'package.json')));
    const cfDirectory = dirname(fileURLToPath(import.meta.resolve('cf/package.json')));
    digest.update(readFileSync(join(cfDirectory, 'package.json')));
    digest.update(readFileSync(join(cfDirectory, 'bin', 'cf')));
    const cfCodeHash = platformWorkerDirectoryHash(join(cfDirectory, 'dist'));
    if (!cfCodeHash) {
      throw new Error('Cloudflare CLI code is unavailable.');
    }
    digest.update(cfCodeHash);
    let dependencyDirectory = dirname(
      fileURLToPath(import.meta.resolve('@cloudflare/build-output-utils')),
    );
    while (!existsSync(join(dependencyDirectory, 'package.json'))) {
      const parent = dirname(dependencyDirectory);
      if (parent === dependencyDirectory) {
        throw new Error('Cloudflare build output package is unavailable.');
      }
      dependencyDirectory = parent;
    }
    digest.update(readFileSync(join(dependencyDirectory, 'package.json')));
    const buildOutputCodeHash = platformWorkerDirectoryHash(join(dependencyDirectory, 'dist'));
    if (!buildOutputCodeHash) {
      throw new Error('Cloudflare build output code is unavailable.');
    }
    digest.update(buildOutputCodeHash);
    const visited = new Set<string>();
    const visit = (path: string, name: string) => {
      if (visited.has(path)) {
        return;
      }
      visited.add(path);
      const source = readFileSync(path);
      digest.update(`${name}\0`);
      digest.update(source);
      const imports = [
        ...source
          .toString('utf8')
          .matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g),
      ]
        .map((match) => match[1]!)
        .sort();
      for (const specifier of imports) {
        visit(resolve(dirname(path), specifier), specifier);
      }
    };
    visit(launcher, 'launcher');
    return (cachedPlatformUploaderHash = digest.digest('hex'));
  } catch {
    return (cachedPlatformUploaderHash = null);
  }
}

function platformWorkerDirectoryHash(directory: string): string | null {
  if (!lstatSync(directory).isDirectory()) {
    return null;
  }
  const digest = createHash('sha256');
  const visit = (path: string, prefix: string): boolean => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = `${prefix}${entry.name}`;
      const absolutePath = join(path, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory:${relativePath}\0`);
        if (!visit(absolutePath, `${relativePath}/`)) {
          return false;
        }
      } else if (entry.isFile()) {
        digest.update(`file:${relativePath}\0`);
        digest.update(createHash('sha256').update(readFileSync(absolutePath)).digest('hex'));
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(directory, '') ? digest.digest('hex') : null;
}

/** Hash every input that can change a version upload; missing or unusual files disable reuse. */
export function platformWorkerUploadFingerprint(
  config: Record<string, unknown>,
  managedRoutes: ReadonlyArray<string> = [],
): string | null {
  const uploaderHash = platformWorkerUploaderHash();
  if (typeof config.main !== 'string' || !uploaderHash) {
    return null;
  }
  try {
    const main = lstatSync(config.main);
    if (!main.isFile()) {
      return null;
    }
    const mainSha256 = createHash('sha256').update(readFileSync(config.main)).digest('hex');
    const normalized: Record<string, unknown> = { ...config, main: { sha256: mainSha256 } };
    if (config.assets !== undefined) {
      const assets = config.assets;
      if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
        return null;
      }
      const directory = (assets as Record<string, unknown>).directory;
      if (typeof directory !== 'string') {
        return null;
      }
      const assetsHash = platformWorkerDirectoryHash(directory);
      if (!assetsHash) {
        return null;
      }
      normalized.assets = {
        ...(assets as Record<string, unknown>),
        directory: assetsHash,
      };
    }
    return createHash('sha256')
      .update(JSON.stringify({ schema: 2, config: normalized, managedRoutes, uploaderHash }))
      .digest('hex');
  } catch {
    return null;
  }
}

function snapshotPlatformWorkerUploadInputs(
  config: Record<string, unknown>,
  directory: string,
): Record<string, unknown> {
  const main = config.main;
  if (typeof main !== 'string') {
    throw new Error('platform: Worker upload has no script artifact.');
  }
  const snapshotMain = join(directory, 'worker-upload.js');
  copyFileSync(main, snapshotMain);
  const snapshot: Record<string, unknown> = { ...config, main: snapshotMain };
  if (config.assets !== undefined) {
    const assets = config.assets as Record<string, unknown>;
    const sourceDirectory = assets.directory;
    if (typeof sourceDirectory !== 'string') {
      throw new Error('platform: Worker upload has no assets directory.');
    }
    const snapshotDirectory = join(directory, 'worker-assets');
    cpSync(sourceDirectory, snapshotDirectory, { recursive: true });
    snapshot.assets = { ...assets, directory: snapshotDirectory };
  }
  return snapshot;
}

function platformWorkerApiReadRunner(
  accountId: string,
  workerName: string,
  readCloudflare: (path: string) => Promise<unknown>,
  fallback: typeof runPlatformWrangler,
): typeof runPlatformWrangler {
  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  return async (args, account, cwd, capture) => {
    try {
      if (args[0] === 'deployments' && (args[1] === 'status' || args[1] === 'list')) {
        const response = await readCloudflare(`${base}/deployments`);
        const deployments =
          response && typeof response === 'object' && !Array.isArray(response)
            ? (response as { deployments?: unknown }).deployments
            : null;
        if (!Array.isArray(deployments)) {
          throw new Error(
            `platform: Cloudflare returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          status: args[1] === 'status' && deployments.length === 0 ? 1 : 0,
          stderr: '',
          stdout: JSON.stringify(args[1] === 'status' ? deployments[0] : deployments),
        };
      }
      if (args[0] === 'versions' && args[1] === 'view' && args[2]) {
        const version = await readCloudflare(`${base}/versions/${encodeURIComponent(args[2])}`);
        return { status: 0, stderr: '', stdout: JSON.stringify(version) };
      }
    } catch {
      // An API read error is not evidence of ownership or deployment lineage.
      // Run the established cf command for the same check.
    }
    return fallback(args, account, cwd, capture);
  };
}

export async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  options: PlatformWorkerDeploymentOptions,
): Promise<PlatformWorkerRollback | null> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  const readRunner = options.readCloudflare
    ? platformWorkerApiReadRunner(accountId, workerName, options.readCloudflare, options.runner)
    : options.runner;
  let activatedVersionId: string | null = null;
  let activatedDeploymentId: string | null = null;
  let uploadedVersionId: string | null = null;
  let previousDeployment: PlatformWorkerDeployment | null = null;
  let previousDeploymentId: string | null = null;
  let previousVersionId: string | null = null;
  const nextTraffic = isolatePlatformWorkerCustomDomains(config);
  const previousTraffic = isolatePlatformWorkerCustomDomains(options.previousConfig);
  let uploadConfig = withoutPlatformWorkerTrafficAttachments(nextTraffic.wranglerConfig);
  const nextTriggers = readTriggerConfigFromObject(nextTraffic.wranglerConfig);
  const contentHash =
    secrets === null ? platformWorkerUploadFingerprint(config, options.managedRoutes) : null;
  const reuseMatchingVersion = options.reuseMatchingVersion !== false;
  let previousTriggers = readTriggerConfigFromObject(previousTraffic.wranglerConfig);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const reconcileExistingVersion = async (
      versionId: string,
      triggerConfig: CloudflareTriggerConfig,
      runner: typeof runPlatformWrangler,
      deploymentId?: string,
    ): Promise<null> => {
      // A reused version still needs its mutable traffic state reconciled.
      try {
        const liveTriggersMatch =
          deploymentId && options.readCloudflare
            ? await platformWorkerLiveTriggersMatch({
                accountId,
                workerName,
                desired: nextTriggers,
                readCloudflare: options.readCloudflare,
              })
            : false;
        if (liveTriggersMatch) {
          const beforeTraffic = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (
            beforeTraffic[0]?.id !== deploymentId ||
            !deploymentRunsOnlyVersion(beforeTraffic[0], versionId)
          ) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during trigger verification.`,
            );
          }
        } else {
          const triggers = await stabilizeCloudflareVersionTriggers({
            configPath,
            knownTriggerConfigs: { [versionId]: nextTriggers },
            manageRoutes: false,
            previousTriggerConfig: triggerConfig,
            publishEmptyCustomDomains: async () => {
              await options.removeCustomDomains();
              return cleanPlatformCommandResult();
            },
            runWrangler: platformWorkerCommandRunner(accountId, directory, runner),
            targetTriggerConfig: nextTriggers,
            targetVersionId: versionId,
            workerName,
          });
          assertPlatformTriggerStabilization(triggers, workerName, versionId, 'publish');
        }
        if (nextTraffic.customDomains.length > 0) {
          await options.publishCustomDomains(workerName, nextTraffic.customDomains);
        }
        if (options.managedRoutes.length > 0) {
          await options.publishRoutes(workerName, options.managedRoutes);
        }
        await options.onTrafficPublished();
        if (
          !deploymentId &&
          (await readActivePlatformWorkerVersion(configPath, accountId, workerName, runner)) !==
            versionId
        ) {
          throw new Error(`platform: Worker ${workerName} changed during traffic reconciliation.`);
        }
        if (deploymentId) {
          const after = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (after[0]?.id !== deploymentId || !deploymentRunsOnlyVersion(after[0], versionId)) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during reconciliation.`,
            );
          }
        }
        return null;
      } catch (error) {
        const failures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} traffic reconciliation failed: ${errorMessage(error)}${
            failures.length > 0 ? ` Safety recovery also failed: ${failures.join('; ')}` : ''
          }`,
          { cause: error },
        );
      }
    };
    if (options.workerExisted && contentHash && reuseMatchingVersion && options.readCloudflare) {
      let candidate:
        | {
            deploymentId: string;
            snapshot: Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>;
          }
        | undefined;
      let changedDuringRead = false;
      try {
        const before = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        const activeVersion =
          before[0]?.versions.length === 1 && before[0].versions[0]?.percentage === 100
            ? before[0].versions[0].versionId
            : null;
        if (!activeVersion) {
          throw new Error(
            `platform: Existing Worker ${workerName} has no single active production version.`,
          );
        }
        const snapshot = await readPlatformWorkerVersionSnapshot(
          configPath,
          accountId,
          workerName,
          readPlatformWorkerOwnershipMarker(config),
          activeVersion,
          readRunner,
        );
        const after = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        changedDuringRead =
          before[0]?.id !== after[0]?.id ||
          !deploymentRunsOnlyVersion(after[0], snapshot.versionId);
        if (!changedDuringRead && snapshot.contentHash === contentHash) {
          candidate = { deploymentId: after[0]!.id, snapshot };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('changed concurrently') ||
            error.message.includes('does not belong to this installation'))
        ) {
          throw error;
        }
        // A read error is not evidence of equality; use the established upload path.
      }
      if (changedDuringRead) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      if (
        candidate &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          candidate.snapshot.versionId,
          candidate.snapshot.triggerConfig,
          readRunner,
          candidate.deploymentId,
        );
      }
    }
    if (options.workerExisted) {
      const previous = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        workerName,
        readPlatformWorkerOwnershipMarker(config),
        readRunner,
      );
      previousVersionId = previous.versionId;
      const deployments = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (!deploymentRunsOnlyVersion(deployments[0], previousVersionId)) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      previousDeployment = deployments[0]!;
      previousDeploymentId = previousDeployment.id;
      if (
        contentHash &&
        reuseMatchingVersion &&
        previous.contentHash === contentHash &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          previousVersionId,
          previous.triggerConfig,
          readRunner,
        );
      }
      uploadConfig = withoutCompletedPlatformWorkerMigrations(uploadConfig, previous.migrationTag);
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
        mode: 0o600,
      });
      previousTriggers = resolvePlatformPreviousTriggerConfig(
        withoutPlatformCustomDomainTriggers(previous.triggerConfig),
        previousTriggers,
        options.previousPublicEndpoints,
      );
      previousTriggers = withoutPlatformCustomDomainTriggers(
        mergePreservedTriggerRoutes(previousTriggers, options.preservedRoutes),
      );
    }
    const immutableConfig = contentHash
      ? snapshotPlatformWorkerUploadInputs(config, directory)
      : null;
    const uploadedContentHash = immutableConfig
      ? platformWorkerUploadFingerprint(immutableConfig, options.managedRoutes)
      : null;
    if (immutableConfig) {
      uploadConfig = {
        ...uploadConfig,
        main: immutableConfig.main,
        ...(immutableConfig.assets === undefined ? {} : { assets: immutableConfig.assets }),
      };
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, { mode: 0o600 });
    }
    const argv = [
      ...(options.workerExisted ? ['versions', 'upload'] : ['deploy']),
      '--config',
      configPath,
      '--strict',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      ...(!options.workerExisted ? ['--autoconfig=false'] : []),
      '--message',
      encodeCloudflareVersionMessage([], nextTriggers, uploadedContentHash ?? undefined),
    ];
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      argv.push('--secrets-file', secretsPath);
    }
    const releaseUploadSlot = await options.acquireUploadSlot?.();
    let uploaded: CloudflareCommandResult;
    let uploadError: unknown;
    try {
      uploaded = options.workerExisted
        ? await options.runner(argv, accountId, directory, true)
        : await runPlatformWranglerForConditionalCreate(
            argv,
            accountId,
            directory,
            true,
            workerName,
            options.apiBaseUrl,
          );
      assertCleanPlatformWrangler(
        uploaded,
        `${options.workerExisted ? 'upload' : 'bootstrap'} ${workerName}`,
      );
    } catch (error) {
      uploadError = error;
      throw error;
    } finally {
      releaseUploadSlot?.(uploadError);
    }
    uploadedVersionId = parseUploadedPlatformWorkerVersion(
      `${uploaded.stdout}\n${uploaded.stderr}`,
    );
    if (!options.workerExisted) {
      activatedVersionId = uploadedVersionId;
    }
    if (!uploadedVersionId) {
      throw new Error(
        `platform: Wrangler uploaded ${workerName} without reporting its immutable version id.`,
      );
    }
    await options.onStaged(previousVersionId, uploadedVersionId, previousTriggers);
    await options.onReadyForActivation?.();
    await options.waitForPriorWorker?.();
    if (options.workerExisted) {
      const deploymentsBeforeActivation = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (
        deploymentsBeforeActivation[0]?.id !== previousDeploymentId ||
        !deploymentRunsOnlyVersion(deploymentsBeforeActivation[0], previousVersionId)
      ) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently before activation; refusing to overwrite it.`,
        );
      }
      activatedVersionId = uploadedVersionId;
      const activated = await options.runner(
        [
          'versions',
          'deploy',
          `${uploadedVersionId}@100`,
          '--config',
          configPath,
          '--message',
          `Void platform activation ${uploadedVersionId}`,
          '--yes',
        ],
        accountId,
        directory,
        true,
      );
      assertCleanPlatformWrangler(activated, `activate ${workerName}`);
    }
    const deploymentsAfterActivation = await readPlatformWorkerDeployments(
      configPath,
      accountId,
      workerName,
      readRunner,
    );
    const lineage = classifyPlatformWorkerDeploymentLineage(
      deploymentsAfterActivation,
      uploadedVersionId,
      previousDeploymentId,
    );
    if (lineage.kind === 'concurrent-after') {
      activatedVersionId = null;
      throw new Error(
        `platform: Worker ${workerName} changed concurrently after activation; refusing to overwrite the newer deployment.`,
      );
    }
    activatedDeploymentId = lineage.deploymentId;
    if (lineage.kind === 'intervening') {
      const interveningDeployment = deploymentsAfterActivation[1];
      activatedVersionId = null;
      activatedDeploymentId = null;
      if (!interveningDeployment) {
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} lost its previous deployment during activation. The cutover cannot be recovered automatically.`,
        );
      }
      try {
        await restorePlatformWorkerDeployment({
          accountId,
          configPath,
          directory,
          expectedActiveDeploymentId: lineage.deploymentId,
          expectedActiveVersionId: uploadedVersionId,
          restoration: interveningDeployment,
          runner: readRunner,
          workerName,
        });
      } catch (recoveryError) {
        const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} changed concurrently during activation, and restoring intervening deployment ${interveningDeployment.id} failed: ${errorMessage(recoveryError)}${
            recoveryFailures.length > 0
              ? ` Safety recovery also failed: ${recoveryFailures.join('; ')}`
              : ''
          }`,
          { cause: recoveryError },
        );
      }
      throw new Error(
        `platform: Worker ${workerName} changed concurrently during activation. The intervening deployment was restored without deleting deployment history.`,
      );
    }
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath,
      knownTriggerConfigs: {
        [uploadedVersionId]: nextTriggers,
        ...(previousVersionId ? { [previousVersionId]: previousTriggers } : {}),
      },
      manageRoutes: false,
      previousTriggerConfig: previousTriggers,
      publishEmptyCustomDomains: async () => {
        await options.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(accountId, directory, readRunner),
      targetTriggerConfig: nextTriggers,
      targetVersionId: uploadedVersionId,
      workerName,
    });
    assertPlatformTriggerStabilization(triggers, workerName, uploadedVersionId, 'publish');
    if (nextTraffic.customDomains.length > 0) {
      await options.publishCustomDomains(workerName, nextTraffic.customDomains);
    }
    if (options.managedRoutes.length > 0) {
      await options.publishRoutes(workerName, options.managedRoutes);
    }
    await options.onTrafficPublished();
    const rollback = () =>
      rollbackPlatformWorker({
        accountId,
        activatedDeploymentId,
        activatedVersionId: uploadedVersionId!,
        config,
        nextTriggers,
        previousConfig: options.previousConfig,
        previousCustomDomains: previousTraffic.customDomains,
        previousDeployment,
        previousTriggers,
        previousVersionId,
        preserveCustomDomains: false,
        inspectNewWorker: options.inspectNewWorker,
        removeCustomDomains: options.removeCustomDomains,
        publishCustomDomains: options.publishCustomDomains,
        retainNewWorker: options.retainNewWorker,
        runner: readRunner,
        workerExisted: options.workerExisted,
        workerName,
      });
    return rollback;
  } catch (error) {
    const unsafeTraffic =
      error instanceof PlatformWorkerCustomDomainsChangedError ||
      error instanceof PlatformWorkerRoutesChangedError;
    const rollbackVersionId = activatedVersionId && uploadedVersionId ? uploadedVersionId : null;
    const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
      checkpointUnsafeTraffic: options.onUnsafeTraffic,
      closeRoutingGate: options.retainNewWorker,
      rollback: rollbackVersionId
        ? () =>
            rollbackPlatformWorker({
              accountId,
              activatedDeploymentId,
              activatedVersionId: rollbackVersionId,
              config,
              nextTriggers: readTriggerConfigFromObject(nextTraffic.wranglerConfig),
              previousConfig: options.previousConfig,
              previousCustomDomains: previousTraffic.customDomains,
              previousDeployment,
              previousTriggers,
              previousVersionId,
              preserveCustomDomains: unsafeTraffic,
              inspectNewWorker: options.inspectNewWorker,
              removeCustomDomains: options.removeCustomDomains,
              publishCustomDomains: options.publishCustomDomains,
              retainNewWorker: options.retainNewWorker,
              runner: readRunner,
              workerExisted: options.workerExisted,
              workerName,
            })
        : null,
      unsafeTraffic,
    });
    if (recoveryFailures.length > 0) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${errorMessage(error)} Automatic recovery for ${workerName} was incomplete: ${recoveryFailures.join('; ')}`,
        { cause: error },
      );
    }
    if (unsafeTraffic) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${errorMessage(error)} The routing gate remains closed and live Custom Domains were retained for safe reconciliation on retry.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function recoverFailedPlatformWorkerDeployment(input: {
  checkpointUnsafeTraffic: () => Promise<void>;
  closeRoutingGate: () => Promise<void>;
  rollback: (() => Promise<void>) | null;
  unsafeTraffic: boolean;
}): Promise<Array<string>> {
  const failures: Array<string> = [];
  const attempt = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  };
  if (input.unsafeTraffic) {
    await attempt('closing the routing gate failed', input.closeRoutingGate);
    await attempt('checkpointing unsafe traffic failed', input.checkpointUnsafeTraffic);
  }
  if (input.rollback) {
    await attempt('Worker rollback failed', input.rollback);
  }
  return failures;
}

async function rollbackPlatformWorker(input: {
  accountId: string;
  activatedDeploymentId: string | null;
  activatedVersionId: string;
  config: Record<string, unknown>;
  nextTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousConfig: Record<string, unknown>;
  previousCustomDomains: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>;
  previousDeployment: PlatformWorkerDeployment | null;
  previousTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousVersionId: string | null;
  preserveCustomDomains: boolean;
  inspectNewWorker: () => Promise<'missing' | 'owned'>;
  removeCustomDomains: () => Promise<void>;
  publishCustomDomains: (
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ) => Promise<void>;
  retainNewWorker: () => Promise<void>;
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
  workerName: string;
}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-rollback-'));
  try {
    const configPath = join(directory, 'wrangler.json');
    const currentTraffic = isolatePlatformWorkerCustomDomains(input.config);
    writeFileSync(configPath, `${JSON.stringify(currentTraffic.wranglerConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    if (!input.workerExisted) {
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      const currentVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (currentVersionId !== input.activatedVersionId) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to delete it.`,
        );
      }
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      await input.retainNewWorker();
      if (!input.preserveCustomDomains) {
        await input.removeCustomDomains();
      }
      return;
    }
    const currentVersionId = await readActivePlatformWorkerVersion(
      configPath,
      input.accountId,
      input.workerName,
      input.runner,
    );
    if (
      currentVersionId !== input.previousVersionId &&
      currentVersionId !== input.activatedVersionId
    ) {
      throw new Error(
        `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to overwrite it.`,
      );
    }
    if (!input.previousVersionId) {
      throw new Error(`Worker ${input.workerName} has no previous version to restore.`);
    }
    if (currentVersionId === input.activatedVersionId) {
      const currentDeployments = await readPlatformWorkerDeployments(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      const activeDeploymentId = input.activatedDeploymentId ?? currentDeployments[0]?.id ?? null;
      const restoration = input.previousDeployment ?? currentDeployments[1];
      if (
        !activeDeploymentId ||
        currentDeployments[0]?.id !== activeDeploymentId ||
        !deploymentRunsOnlyVersion(currentDeployments[0], input.activatedVersionId) ||
        !restoration ||
        currentDeployments[1]?.id !== restoration.id ||
        !deploymentRunsOnlyVersion(restoration, input.previousVersionId)
      ) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently after installer deployment; refusing to alter its deployment history.`,
        );
      }
      await restorePlatformWorkerDeployment({
        accountId: input.accountId,
        configPath,
        directory,
        expectedActiveDeploymentId: activeDeploymentId,
        expectedActiveVersionId: input.activatedVersionId,
        restoration,
        runner: input.runner,
        workerName: input.workerName,
      });
      const restoredVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (restoredVersionId !== input.previousVersionId) {
        throw new Error(
          `Worker ${input.workerName} did not restore immutable version ${input.previousVersionId} after rolling back installer deployment ${activeDeploymentId}.`,
        );
      }
    }
    const previousConfigPath = join(directory, 'wrangler.previous.json');
    writeFileSync(previousConfigPath, `${JSON.stringify(input.previousConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath: previousConfigPath,
      knownTriggerConfigs: {
        [input.activatedVersionId]: input.nextTriggers,
        [input.previousVersionId]: input.previousTriggers,
      },
      manageRoutes: false,
      previousTriggerConfig: input.nextTriggers,
      publishEmptyCustomDomains: async () => {
        await input.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(input.accountId, directory, input.runner),
      targetTriggerConfig: input.previousTriggers,
      targetVersionId: input.previousVersionId,
      workerName: input.workerName,
    });
    assertPlatformTriggerStabilization(
      triggers,
      input.workerName,
      input.previousVersionId,
      'restore',
    );
    if (!input.preserveCustomDomains && input.previousCustomDomains.length > 0) {
      await input.publishCustomDomains(input.workerName, input.previousCustomDomains);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function platformWorkerCommandRunner(
  accountId: string,
  cwd: string,
  runner: typeof runPlatformWrangler,
): CloudflareCommandRunner {
  return (args, options) => runner(args, accountId, cwd, options.capture);
}

export async function runPlatformWrangler(
  args: ReadonlyArray<string>,
  accountId: string,
  cwd: string,
  capture: boolean,
): Promise<CloudflareCommandResult> {
  return runPlatformWranglerAtApiBase(args, accountId, cwd, capture);
}

const PLATFORM_WRANGLER_TIMEOUT_MS = 10 * 60 * 1000;

async function runPlatformWranglerAtApiBase(
  args: ReadonlyArray<string>,
  accountId: string,
  cwd: string,
  capture: boolean,
  apiBaseUrl = resolvePinnedApiBaseUrl(),
  parallelWorkerUpload = false,
): Promise<CloudflareCommandResult> {
  const startedAt = performance.now();
  const runner = createDefaultRunWrangler(process.cwd(), {
    launcher: resolveWranglerArgv(process.cwd()),
    parallelWorkerUpload,
    timeoutMs: PLATFORM_WRANGLER_TIMEOUT_MS,
  });
  const result = await runner([...args], {
    accountId,
    apiBaseUrl,
    captureJson: capture,
    cwd,
  });
  if (process.env.VOID_PLATFORM_TIMINGS === '1') {
    const operation =
      args[0] === 'versions' || args[0] === 'deployments'
        ? `${args[0]} ${args[1] ?? ''}`
        : (args[0] ?? 'unknown');
    process.stderr.write(
      `[platform timing] wrangler ${operation} ${(performance.now() - startedAt).toFixed(0)} ms\n`,
    );
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  // Void owns progress output. Successful commands may still emit banners and
  // warnings; keep those captured, but retain diagnostics for failed commands.
  if (!capture && result.status !== 0) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }
  return {
    status: result.status,
    stderr,
    stdout,
  };
}

type ConditionalWorkerCreateState = {
  assetSessionStarted: boolean;
  attempted: boolean;
  conflictStatus: number | null;
  created: boolean;
  forwarded: boolean;
  rejectedMutation: string | null;
};

type ConditionalWorkerCreateProxy = Readonly<{
  apiBaseUrl: string;
  close: () => Promise<void>;
  state: ConditionalWorkerCreateState;
}>;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
    server.closeAllConnections();
  });
}

async function startConditionalWorkerCreateProxy(
  upstreamApiBaseUrl: string,
  accountId: string,
  workerName: string,
): Promise<ConditionalWorkerCreateProxy> {
  const upstreamBase = new URL(upstreamApiBaseUrl);
  if (upstreamBase.protocol !== 'http:' && upstreamBase.protocol !== 'https:') {
    throw new Error('platform: Cloudflare API base URL must use HTTP or HTTPS.');
  }
  const basePath = upstreamBase.pathname.replace(/\/+$/, '');
  const accountPath = `${basePath}/accounts/${encodeURIComponent(accountId)}`;
  const expectedPath = `${accountPath}/workers/scripts/${encodeURIComponent(workerName)}`;
  const assetUploadPath = `${accountPath}/workers/assets/upload`;
  const state: ConditionalWorkerCreateState = {
    assetSessionStarted: false,
    attempted: false,
    conflictStatus: null,
    created: false,
    forwarded: false,
    rejectedMutation: null,
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const incomingUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (incomingUrl.pathname !== basePath && !incomingUrl.pathname.startsWith(`${basePath}/`)) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        outgoing.end('{"success":false,"errors":[{"message":"Invalid API proxy path"}]}');
        return;
      }
      // Wrangler omits script content from the response and requests strict
      // binding inheritance. These are the only accepted create-query options.
      const createQuery = [...incomingUrl.searchParams];
      const supportedCreateQuery =
        new Set(createQuery.map(([key]) => key)).size === createQuery.length &&
        createQuery.every(
          ([key, value]) =>
            (key === 'excludeScript' && value === 'true') ||
            (key === 'bindings_inherit' && value === 'strict'),
        );
      const isConditionalCreate =
        incoming.method === 'PUT' && incomingUrl.pathname === expectedPath && supportedCreateQuery;
      const isTopLevelWorkerUpload =
        incoming.method === 'PUT' &&
        new RegExp(
          `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/accounts/[^/]+/workers/scripts/[^/]+$`,
        ).test(incomingUrl.pathname);
      const isReadOnly =
        incoming.method === 'GET' || incoming.method === 'HEAD' || incoming.method === 'OPTIONS';
      // A Worker with static assets must register its asset manifest and upload
      // the missing files before the script PUT that references them. Neither
      // step attaches anything to a Worker; only the guarded create does.
      const isAssetUploadSession =
        incoming.method === 'POST' &&
        incomingUrl.pathname === `${expectedPath}/assets-upload-session` &&
        incomingUrl.search === '';
      const isAssetUpload =
        incoming.method === 'POST' &&
        state.assetSessionStarted &&
        ((incomingUrl.pathname === assetUploadPath && incomingUrl.search === '?base64=true') ||
          (incomingUrl.search === '' &&
            incomingUrl.pathname.startsWith(`${assetUploadPath}/`) &&
            /^[0-9a-f]{32}$/.test(incomingUrl.pathname.slice(assetUploadPath.length + 1))));
      if (
        (isTopLevelWorkerUpload && !isConditionalCreate) ||
        (!isReadOnly &&
          !isConditionalCreate &&
          !isAssetUploadSession &&
          !isAssetUpload &&
          !state.created)
      ) {
        state.rejectedMutation = `${incoming.method ?? 'UNKNOWN'} ${incomingUrl.pathname}${
          incomingUrl.pathname === expectedPath && !supportedCreateQuery
            ? ' (unsupported Worker create query)'
            : ''
        }`;
        incoming.resume();
        outgoing.writeHead(409, { 'Content-Type': 'application/json' });
        outgoing.end(
          '{"success":false,"errors":[{"message":"Mutation blocked until conditional Worker creation succeeds"}]}',
        );
        return;
      }
      const headers = forwardHeaders(incoming.headers);
      delete headers.host;
      if (isConditionalCreate) {
        state.attempted = true;
        headers['if-none-match'] = '*';
      }
      if (isAssetUploadSession) {
        state.assetSessionStarted = true;
      }
      const upstreamUrl = new URL(
        `${incomingUrl.pathname}${incomingUrl.search}`,
        upstreamBase.origin,
      );
      const request = (upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
        upstreamUrl,
        {
          headers,
          method: incoming.method,
        },
        (response) => {
          if (isConditionalCreate) {
            state.forwarded = true;
            if (response.statusCode === 409 || response.statusCode === 412) {
              state.conflictStatus = response.statusCode;
            }
            state.created =
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300;
          }
          const responseHeaders = forwardHeaders(response.headers);
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
          response.pipe(outgoing);
        },
      );
      request.on('error', () => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        }
        outgoing.end(
          '{"success":false,"errors":[{"message":"Cloudflare API proxy request failed"}]}',
        );
      });
      incoming.pipe(request);
    })().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
      }
      outgoing.end('{"success":false,"errors":[{"message":"Cloudflare API proxy failed"}]}');
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    close: () => closeHttpServer(server),
    state,
  };
}

export async function withConditionalPlatformWorkerCreate<T>(
  accountId: string,
  workerName: string,
  operation: (apiBaseUrl: string) => Promise<T>,
  upstreamApiBaseUrl: string = resolvePinnedApiBaseUrl(),
): Promise<T> {
  const proxy = await startConditionalWorkerCreateProxy(upstreamApiBaseUrl, accountId, workerName);
  let result: T;
  try {
    result = await operation(proxy.apiBaseUrl);
  } finally {
    await proxy.close();
  }
  if (proxy.state.rejectedMutation) {
    throw new Error(
      `platform: Wrangler attempted unexpected mutation ${proxy.state.rejectedMutation} while conditionally creating new Worker ${workerName}; the mutation was blocked.`,
    );
  }
  if (!proxy.state.attempted || !proxy.state.forwarded) {
    throw new Error(
      `platform: Wrangler did not use the guarded create endpoint for new Worker ${workerName}; refusing an unverified deployment.`,
    );
  }
  if (proxy.state.conflictStatus !== null) {
    throw new Error(
      `platform: Worker ${workerName} was created concurrently (HTTP ${proxy.state.conflictStatus}); no existing Worker was changed. Re-run to inspect the collision.`,
    );
  }
  return result;
}

async function runPlatformWranglerForConditionalCreate(
  args: ReadonlyArray<string>,
  accountId: string,
  cwd: string,
  capture: boolean,
  workerName: string,
  upstreamApiBaseUrl: string,
): Promise<CloudflareCommandResult> {
  return withConditionalPlatformWorkerCreate(
    accountId,
    workerName,
    (apiBaseUrl) => runPlatformWranglerAtApiBase(args, accountId, cwd, capture, apiBaseUrl),
    upstreamApiBaseUrl,
  );
}

async function readActivePlatformWorkerVersion(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<string | null> {
  const result = await runner(
    ['deployments', 'status', '--config', configPath, '--name', workerName, '--json'],
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read active version for ${workerName}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`platform: Wrangler returned malformed deployment status for ${workerName}.`);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { versions?: unknown }).versions)
  ) {
    throw new Error(`platform: Wrangler returned malformed deployment status for ${workerName}.`);
  }
  const active = (value as { versions: Array<unknown> }).versions.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      Number((entry as { percentage?: unknown }).percentage) === 100,
  );
  if (
    active.length !== 1 ||
    typeof (active[0] as { version_id?: unknown }).version_id !== 'string'
  ) {
    return null;
  }
  return (active[0] as { version_id: string }).version_id;
}

export type PlatformWorkerDeployment = Readonly<{
  id: string;
  versions: ReadonlyArray<Readonly<{ percentage: number; versionId: string }>>;
}>;

export async function readPlatformWorkerDeployments(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<ReadonlyArray<PlatformWorkerDeployment>> {
  const result = await runner(
    ['deployments', 'list', '--config', configPath, '--name', workerName, '--json'],
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read deployment lineage for ${workerName}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`platform: Wrangler returned malformed deployment history for ${workerName}.`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`platform: Wrangler returned malformed deployment history for ${workerName}.`);
  }
  return value
    .map((entry, index) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { created_on?: unknown }).created_on !== 'string' ||
        !Array.isArray((entry as { versions?: unknown }).versions)
      ) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const createdAt = Date.parse((entry as { created_on: string }).created_on);
      if (!Number.isFinite(createdAt)) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const versions = (entry as { versions: Array<unknown> }).versions.map((version) => {
        if (
          !version ||
          typeof version !== 'object' ||
          typeof (version as { version_id?: unknown }).version_id !== 'string' ||
          !Number.isFinite(Number((version as { percentage?: unknown }).percentage))
        ) {
          throw new Error(
            `platform: Wrangler returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          percentage: Number((version as { percentage: unknown }).percentage),
          versionId: (version as { version_id: string }).version_id,
        };
      });
      return { createdAt, id: (entry as { id: string }).id, index, versions };
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.index - right.index)
    .map(({ id, versions }) => ({ id, versions }));
}

function samePlatformWorkerTraffic(
  left: PlatformWorkerDeployment | undefined,
  right: PlatformWorkerDeployment,
): boolean {
  if (!left) {
    return false;
  }
  const normalize = (deployment: PlatformWorkerDeployment) =>
    deployment.versions
      .filter((version) => version.percentage > 0)
      .map((version) => `${version.versionId}@${version.percentage}`)
      .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export async function restorePlatformWorkerDeployment(input: {
  accountId: string;
  configPath: string;
  directory: string;
  expectedActiveDeploymentId: string;
  expectedActiveVersionId: string;
  restoration: PlatformWorkerDeployment;
  runner: typeof runPlatformWrangler;
  workerName: string;
}): Promise<void> {
  const restorationVersions = input.restoration.versions.filter(
    (version) => version.percentage > 0,
  );
  const totalPercentage = restorationVersions.reduce(
    (total, version) => total + version.percentage,
    0,
  );
  if (
    restorationVersions.length === 0 ||
    restorationVersions.length > 2 ||
    restorationVersions.some(
      (version, index) =>
        version.percentage > 100 ||
        restorationVersions.findIndex((entry) => entry.versionId === version.versionId) !== index,
    ) ||
    Math.abs(totalPercentage - 100) > 0.001
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment ${input.restoration.id} has an unsupported traffic distribution.`,
    );
  }
  const before = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    before[0]?.id !== input.expectedActiveDeploymentId ||
    !deploymentRunsOnlyVersion(before[0], input.expectedActiveVersionId) ||
    before[1]?.id !== input.restoration.id ||
    !samePlatformWorkerTraffic(before[1], input.restoration)
  ) {
    throw new Error(
      `Worker ${input.workerName} changed concurrently before deployment restoration; refusing to overwrite the newer deployment.`,
    );
  }
  const restored = await input.runner(
    [
      'versions',
      'deploy',
      ...restorationVersions.map((version) => `${version.versionId}@${version.percentage}`),
      '--config',
      input.configPath,
      '--message',
      `Void platform restoration ${input.restoration.id}`,
      '--yes',
    ],
    input.accountId,
    input.directory,
    true,
  );
  assertCleanPlatformWrangler(restored, `restore deployment ${input.restoration.id}`);
  const after = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    !samePlatformWorkerTraffic(after[0], input.restoration) ||
    after[1]?.id !== input.expectedActiveDeploymentId
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment restoration was superseded or did not restore deployment ${input.restoration.id}.`,
    );
  }
}

function deploymentRunsOnlyVersion(
  deployment: PlatformWorkerDeployment | undefined,
  versionId: string | null,
): boolean {
  return (
    versionId !== null &&
    deployment?.versions.length === 1 &&
    deployment.versions[0]?.versionId === versionId &&
    deployment.versions[0].percentage === 100
  );
}

export function classifyPlatformWorkerDeploymentLineage(
  deployments: ReadonlyArray<PlatformWorkerDeployment>,
  installedVersionId: string,
  previousDeploymentId: string | null,
):
  | Readonly<{ deploymentId: string; kind: 'committed' }>
  | Readonly<{ kind: 'concurrent-after' }>
  | Readonly<{ deploymentId: string; kind: 'intervening' }> {
  const installed = deployments[0];
  if (!deploymentRunsOnlyVersion(installed, installedVersionId)) {
    return { kind: 'concurrent-after' };
  }
  return (deployments[1]?.id ?? null) === previousDeploymentId
    ? { deploymentId: installed.id, kind: 'committed' }
    : { deploymentId: installed.id, kind: 'intervening' };
}

export async function inspectNewPlatformWorker(
  client: WorkerInspectionClient,
  accountId: string,
  manifest: PlatformInstallationManifest,
  resourceKey: string,
  workerName: string,
): Promise<'missing' | 'owned'> {
  if (!client.listWorkerNames || !client.getWorkerPlainTextBindings) {
    throw new Error('platform: Cloudflare Worker ownership inspection is unavailable.');
  }
  const workerNames = await client.listWorkerNames(accountId);
  if (!workerNames.includes(workerName)) {
    return 'missing';
  }
  const bindings = await client.getWorkerPlainTextBindings(accountId, workerName);
  let marker;
  try {
    marker = parsePlatformResourceOwnershipMarker(
      JSON.parse(bindings.PLATFORM_OWNERSHIP_MARKER ?? 'null'),
    );
  } catch {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: workerName,
    resourceKey,
    resourceKind: 'worker',
    resourceName: workerName,
  });
  if (
    marker.accountId !== expected.accountId ||
    marker.installationId !== expected.installationId ||
    marker.ownershipNonce !== expected.ownershipNonce ||
    marker.resourceId !== expected.resourceId ||
    marker.resourceKey !== expected.resourceKey ||
    marker.resourceKind !== expected.resourceKind ||
    marker.resourceName !== expected.resourceName
  ) {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  return 'owned';
}

function readPlatformWorkerOwnershipMarker(config: Record<string, unknown>): string {
  const vars = config.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new Error('platform: Platform Worker config is missing its ownership bindings.');
  }
  const marker = (vars as Record<string, unknown>).PLATFORM_OWNERSHIP_MARKER;
  if (typeof marker !== 'string' || marker === '') {
    throw new Error('platform: Platform Worker config is missing its ownership marker.');
  }
  return marker;
}

export async function readActivePlatformWorkerSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<{
  contentHash?: string;
  migrationTag: string | null;
  triggerConfig: CloudflareTriggerConfig;
  versionId: string;
}> {
  const readActiveVersion = () =>
    readActivePlatformWorkerVersion(configPath, accountId, workerName, runner);
  const versionId = await readActiveVersion();
  if (!versionId) {
    throw new Error(
      `platform: Existing Worker ${workerName} has no single active production version.`,
    );
  }
  const snapshot = await readPlatformWorkerVersionSnapshot(
    configPath,
    accountId,
    workerName,
    expectedOwnershipMarker,
    versionId,
    runner,
    async () => {
      if ((await readActiveVersion()) !== versionId) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its active version was inspected.`,
        );
      }
    },
  );
  return snapshot;
}

async function readPlatformWorkerVersionSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  versionId: string,
  runner: typeof runPlatformWrangler,
  validateCurrentVersion?: () => Promise<void>,
): Promise<Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>> {
  const result = await runner(
    ['versions', 'view', versionId, '--config', configPath, '--name', workerName, '--json'],
    accountId,
    process.cwd(),
    true,
  );
  assertCleanPlatformWrangler(result, `read rollback metadata for ${workerName}`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  const resources = (value as { resources?: unknown }).resources;
  const bindings =
    resources && typeof resources === 'object' && !Array.isArray(resources)
      ? (resources as { bindings?: unknown }).bindings
      : null;
  const ownershipBindings = Array.isArray(bindings)
    ? bindings.filter(
        (binding) =>
          binding &&
          typeof binding === 'object' &&
          (binding as { name?: unknown }).name === 'PLATFORM_OWNERSHIP_MARKER' &&
          (binding as { type?: unknown }).type === 'plain_text' &&
          typeof (binding as { text?: unknown }).text === 'string',
      )
    : [];
  if (
    ownershipBindings.length !== 1 ||
    (ownershipBindings[0] as { text: string }).text !== expectedOwnershipMarker
  ) {
    throw new Error(
      `platform: Active Worker version ${versionId} for ${workerName} does not belong to this installation.`,
    );
  }
  await validateCurrentVersion?.();
  const annotations = (value as { annotations?: unknown }).annotations;
  const message =
    annotations &&
    typeof annotations === 'object' &&
    typeof (annotations as Record<string, unknown>)['workers/message'] === 'string'
      ? ((annotations as Record<string, string>)['workers/message'] ?? null)
      : null;
  const metadata = parseCloudflareVersionMessage(message);
  if (metadata?.schema !== 2) {
    throw new Error(
      `platform: Active Worker ${workerName} predates safe trigger snapshots. Refusing to upgrade because its routes, cron, and queue consumers could not be restored after a failed cutover.`,
    );
  }
  const migrationTag = readCloudflareVersionMigrationTag(value);
  return {
    ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
    migrationTag,
    triggerConfig: metadata.triggerConfig,
    versionId,
  };
}

export function withoutCompletedPlatformWorkerMigrations(
  config: Record<string, unknown>,
  activeMigrationTag: string | null,
): Record<string, unknown> {
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const target = migrations.at(-1);
  if (
    activeMigrationTag === null ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    (target as { tag?: unknown }).tag !== activeMigrationTag
  ) {
    return config;
  }
  const result = { ...config };
  delete result.migrations;
  return result;
}

function parseUploadedPlatformWorkerVersion(output: string): string | null {
  return /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(output)?.[1] ?? null;
}

function assertCleanPlatformWrangler(result: CloudflareCommandResult, operation: string): void {
  if (result.status !== 0) {
    throw new Error(
      `platform: Wrangler failed to ${operation} (${result.stderr.trim() || `exit ${result.status}`}).`,
    );
  }
}

function cleanPlatformCommandResult(): CloudflareCommandResult {
  return { status: 0, stderr: '', stdout: '' };
}

function assertPlatformTriggerStabilization(
  result: Awaited<ReturnType<typeof stabilizeCloudflareVersionTriggers>>,
  workerName: string,
  targetVersionId: string,
  operation: string,
): void {
  if (!result.ok) {
    throw new Error(
      `platform: Failed to ${operation} triggers for ${workerName} (${result.reason}).`,
    );
  }
  if (!result.targetOwnsTraffic) {
    throw new Error(
      `platform: Worker ${workerName} was superseded by ${result.activeVersionId} while publishing ${targetVersionId}; its active trigger state was repaired.`,
    );
  }
}

function readTriggerConfigFromObject(config: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-triggers-'));
  try {
    const path = join(directory, 'wrangler.json');
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return readCloudflareTriggerConfig(path);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function verifyRuntimeArtifacts(
  runtimeDirectory: string,
  manifest: PlatformRuntimeManifest,
): void {
  for (const artifact of [
    ...Object.values(manifest.artifacts),
    ...(manifest.assets
      ? [
          manifest.assets.adminClient,
          ...(manifest.assets.adminStyle ? [manifest.assets.adminStyle] : []),
        ]
      : []),
  ]) {
    const path = join(runtimeDirectory, artifact.path);
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch (error) {
      throw new Error(`platform: Runtime artifact is missing: ${errorMessage(error)}`);
    }
    if (contents.byteLength !== artifact.size || hash(contents) !== artifact.sha256) {
      throw new Error(`platform: Runtime artifact failed integrity verification: ${path}.`);
    }
  }
  verifyPlatformDatabaseArtifacts(runtimeDirectory, manifest.database);
}

export function verifyPlatformDatabaseArtifacts(
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
): void {
  const journalPath = join(runtimeDirectory, 'drizzle', 'meta', '_journal.json');
  let journal: Buffer;
  try {
    journal = readFileSync(journalPath);
  } catch (error) {
    throw new Error(
      `platform: Runtime database migration journal is missing: ${errorMessage(error)}`,
    );
  }
  if (hash(journal) !== database.journalSha256) {
    throw new Error(
      `platform: Runtime database migration journal failed integrity verification: ${journalPath}.`,
    );
  }
  for (const migration of database.migrations) {
    const path = join(runtimeDirectory, 'drizzle', `${migration.tag}.sql`);
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch (error) {
      throw new Error(`platform: Runtime database migration is missing: ${errorMessage(error)}`);
    }
    if (hash(contents) !== migration.sha256) {
      throw new Error(
        `platform: Runtime database migration failed integrity verification: ${path}.`,
      );
    }
  }
}

function nextTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return (
    Math.max(
      0,
      ...manifest.steps.flatMap((step) => {
        const match = /^traffic-enabled:(\d+)$/.exec(step.key);
        return match ? [Number(match[1])] : [];
      }),
    ) + 1
  );
}

type PlatformWorkerKey = 'api' | 'proxy' | 'emailGateway' | 'tail' | 'dispatch';

type PlatformWorkerCutoverSnapshot = Readonly<{
  previousVersionId: string | null;
  previousTriggers: CloudflareTriggerConfig;
  stagedVersionId: string;
  workerName: string;
}>;

type InterruptedWorkerCutover = Readonly<{
  generation: number;
  staged: ReadonlyMap<PlatformWorkerKey, PlatformWorkerCutoverSnapshot>;
  unsafeTraffic: ReadonlySet<PlatformWorkerKey>;
}>;

function nextWorkerCutoverGeneration(manifest: PlatformInstallationManifest): number {
  return latestPlatformWorkerCutoverGeneration(manifest) + 1;
}

function recordWorkerSecretUpdateState(
  manifest: PlatformInstallationManifest,
  generation: number,
  state: 'pending' | 'committed',
  intentId: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-secret-updates:${generation}:${state}`,
      resultHash: intentId,
    },
    completedAt,
  );
}

function recordWorkerCutoverStage(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  previousVersionId: string | null,
  stagedVersionId: string,
  workerName: string,
  previousTriggers: CloudflareTriggerConfig,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:staged:${key}`,
      resultHash: Buffer.from(
        JSON.stringify({
          previousTriggers,
          previousVersionId,
          schema: 1,
          stagedVersionId,
          workerName,
        }),
      ).toString('base64url'),
    },
    completedAt,
  );
}

function recordWorkerCutoverResolution(
  manifest: PlatformInstallationManifest,
  generation: number,
  resolution: 'committed' | 'restored',
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:${resolution}`,
      resultHash: resolution,
    },
    completedAt,
  );
}

function recordWorkerUnsafeTraffic(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  workerName: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:unsafe-traffic:${key}`,
      resultHash: workerName,
    },
    completedAt,
  );
}

function parseWorkerCutoverSnapshot(value: string): PlatformWorkerCutoverSnapshot | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      previousTriggers?: unknown;
      previousVersionId?: unknown;
      schema?: unknown;
      stagedVersionId?: unknown;
      workerName?: unknown;
    };
    const metadata = parseCloudflareVersionMessage(
      `void:${JSON.stringify({
        migrations: [],
        schema: 2,
        triggerConfig: parsed.previousTriggers,
      })}`,
    );
    if (
      parsed.schema !== 1 ||
      (parsed.previousVersionId !== null && typeof parsed.previousVersionId !== 'string') ||
      typeof parsed.stagedVersionId !== 'string' ||
      parsed.stagedVersionId === '' ||
      typeof parsed.workerName !== 'string' ||
      parsed.workerName === '' ||
      metadata?.schema !== 2
    ) {
      return null;
    }
    return {
      previousTriggers: metadata.triggerConfig,
      previousVersionId: parsed.previousVersionId,
      stagedVersionId: parsed.stagedVersionId,
      workerName: parsed.workerName,
    };
  } catch {
    return null;
  }
}

function interruptedWorkerCutover(
  manifest: PlatformInstallationManifest,
): InterruptedWorkerCutover | null {
  const generations = new Map<
    number,
    {
      resolved: boolean;
      staged: Map<
        PlatformWorkerKey,
        {
          previousVersionId: string | null;
          previousTriggers: CloudflareTriggerConfig;
          stagedVersionId: string;
          workerName: string;
        }
      >;
      unsafeTraffic: Set<PlatformWorkerKey>;
    }
  >();
  for (const step of manifest.steps) {
    const resolution = /^worker-cutover:(\d+):(committed|restored)$/.exec(step.key);
    if (resolution) {
      const generation = Number(resolution[1]);
      const entry = generations.get(generation) ?? {
        resolved: false,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.resolved = true;
      generations.set(generation, entry);
      continue;
    }
    const unsafeTraffic =
      /^worker-cutover:(\d+):unsafe-traffic:(api|proxy|emailGateway|tail|dispatch)$/.exec(step.key);
    if (unsafeTraffic) {
      const generation = Number(unsafeTraffic[1]);
      const entry = generations.get(generation) ?? {
        resolved: false,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.unsafeTraffic.add(unsafeTraffic[2] as PlatformWorkerKey);
      generations.set(generation, entry);
      continue;
    }
    const staged = /^worker-cutover:(\d+):staged:(api|proxy|emailGateway|tail|dispatch)$/.exec(
      step.key,
    );
    if (!staged) {
      continue;
    }
    const generation = Number(staged[1]);
    const snapshot = parseWorkerCutoverSnapshot(step.resultHash);
    if (!snapshot) {
      throw new Error(`platform: Invalid Worker cutover checkpoint ${step.key}.`);
    }
    const entry = generations.get(generation) ?? {
      resolved: false,
      staged: new Map(),
      unsafeTraffic: new Set(),
    };
    entry.staged.set(staged[2] as PlatformWorkerKey, snapshot);
    generations.set(generation, entry);
  }
  const unresolved = [...generations.entries()]
    .filter(([, entry]) => !entry.resolved && entry.staged.size > 0)
    .sort(([left], [right]) => right - left)[0];
  return unresolved
    ? {
        generation: unresolved[0],
        staged: unresolved[1].staged,
        unsafeTraffic: unresolved[1].unsafeTraffic,
      }
    : null;
}

export async function verifyPlatformWorkerCutoverVersions(
  manifest: PlatformInstallationManifest,
  generation: number,
  configs: Record<PlatformWorkerKey, Record<string, unknown>>,
  accountId: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
  workerKeys: ReadonlyArray<PlatformWorkerKey> = [
    'api',
    'proxy',
    'emailGateway',
    'tail',
    'dispatch',
  ],
): Promise<void> {
  const cutover = interruptedWorkerCutover(manifest);
  if (cutover?.generation !== generation || cutover.staged.size !== workerKeys.length) {
    throw new Error(
      `platform: Worker cutover generation ${generation} is missing a complete immutable-version checkpoint.`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-cutover-verify-'));
  try {
    for (const key of workerKeys) {
      const snapshot = cutover.staged.get(key);
      if (!snapshot) {
        throw new Error(
          `platform: Worker cutover generation ${generation} is missing its ${key} checkpoint.`,
        );
      }
      const config = configs[key];
      const configPath = join(directory, `${key}.wrangler.json`);
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const active = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        snapshot.workerName,
        readPlatformWorkerOwnershipMarker(config),
        runner,
      );
      if (active.versionId !== snapshot.stagedVersionId) {
        throw new Error(
          `platform: Worker ${snapshot.workerName} changed concurrently from staged version ${snapshot.stagedVersionId} to ${active.versionId}; refusing to enable platform traffic.`,
        );
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function recordWorkerTrafficState(
  manifest: PlatformInstallationManifest,
  generation: number,
  enabled: boolean,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-traffic-state:${generation}`,
      resultHash: enabled ? 'enabled' : 'disabled',
    },
    completedAt,
  );
}

export function stablePublicEndpointState(existing: PlatformInstallationManifest | null): boolean {
  if (!existing) {
    return false;
  }
  // `void platform disable` removes traffic without redeploying Workers, so it
  // does not create a Worker cutover marker. Its durable desired state is
  // authoritative over the last successful install/upgrade marker.
  if (existing.status === 'disabled' || existing.desiredState === 'disabled') {
    return false;
  }
  const latest = existing.steps
    .flatMap((step) => {
      const match = /^worker-traffic-state:(\d+)$/.exec(step.key);
      return match ? [{ generation: Number(match[1]), state: step.resultHash }] : [];
    })
    .sort((left, right) => right.generation - left.generation)[0];
  if (latest) {
    return latest.state === 'enabled';
  }
  // Older manifests do not have a Worker traffic marker. Only a completed
  // install proves that their endpoints were ever intentionally published.
  // Fresh and interrupted installs begin with desiredState=enabled, so using
  // desired state here would let a resume bypass the initial traffic gate.
  return existing.status === 'installed';
}

export function resolvePlatformPreviousTriggerConfig(
  versionSnapshot: CloudflareTriggerConfig,
  configuredSnapshot: CloudflareTriggerConfig,
  publicEndpoints: boolean,
): CloudflareTriggerConfig {
  if (publicEndpoints) {
    return versionSnapshot;
  }
  // Disable removes public traffic without uploading a new immutable Worker
  // version, so the active version message can still describe the last enabled
  // routes. The durable lifecycle state owns those three traffic fields while
  // the version message remains authoritative for cron, queue, and workflow
  // triggers that disable does not change.
  return {
    ...versionSnapshot,
    preview_urls: configuredSnapshot.preview_urls,
    routes: configuredSnapshot.routes,
    workers_dev: configuredSnapshot.workers_dev,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PlatformHealthCheckContext = Readonly<{
  accountName: string;
  workers: ReadonlyArray<string>;
  resumeCommand?: string;
  emailGatewayUrl?: string;
}>;

export class PlatformAccessBlockedError extends Error {
  constructor(url: string, context?: PlatformHealthCheckContext) {
    super(
      [
        'platform: Cloudflare Access blocked the platform health checks (Default-Deny, error 1050).',
        `Blocked URL: ${url}`,
        '',
        'To make this test platform publicly reachable:',
        '',
        `1. In ${context ? `account ${JSON.stringify(context.accountName)}` : 'your Cloudflare account'}, open:`,
        '   Zero Trust → Access controls → Applications → Create new application.',
        '2. Choose Self-hosted. When adding destinations, choose Worker and select:',
        `   ${context ? context.workers.join(', ') + '.' : "This installation's API, proxy, and dispatch Workers."}`,
        '3. Add a policy: Action → Bypass; Include → Everyone.',
        context?.resumeCommand
          ? `4. Save the policy and application, then resume:\n\n   ${context.resumeCommand}`
          : '4. Save the policy and application, then rerun your platform command.',
        '',
        'This removes Cloudflare Access protection for these Workers.',
        'Void’s own authentication stays enabled. Keep account-wide Default-Deny on.',
        '',
        'For platforms that must remain Access-protected:',
        'https://void.cloud/guide/platform/installation/maintenance#cloudflare-access',
      ].join('\n'),
    );
  }
}

async function platformProbeFailure(
  label: string,
  url: string,
  response: Response,
  context?: PlatformHealthCheckContext,
): Promise<Error> {
  const message = `platform: ${label} failed at ${url} (HTTP ${response.status}).`;
  if (
    response.status === 403 &&
    response.headers.get('server')?.toLowerCase() === 'cloudflare' &&
    response.headers.get('content-type')?.toLowerCase().includes('text/html')
  ) {
    const body = await response.text().catch(() => '');
    if (body.includes('Default-Deny') && /errorCode:\s*1050\b/.test(body)) {
      return new PlatformAccessBlockedError(url, context);
    }
  }
  return new Error(message);
}

export async function verifyPlatformHealth(
  apiUrl: string,
  installationId: string,
  proxyUrl: string,
  applicationBaseDomain: string,
  platformVersion: string,
  usageProtocolVersion: 0 | 1 | 2,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
  dispatchOrigin?: string,
  context?: PlatformHealthCheckContext,
): Promise<void> {
  const request = (url: string) =>
    fetcher(url, {
      headers: {
        'X-Void-Platform-Probe': healthProbeToken,
        ...cfAccessHeaders(process.env, url),
      },
      // A login redirect must not forward the installation's probe credential.
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  const dispatchUrl = dispatchOrigin ?? `https://test.${applicationBaseDomain}`;
  const [health, discovery, proxy, dispatch, emailGateway] = await Promise.all([
    request(`${apiUrl}/health`),
    request(`${apiUrl}/.well-known/void-platform`),
    request(`${proxyUrl}/health`),
    request(`${dispatchUrl}/health`),
    context?.emailGatewayUrl ? request(`${context.emailGatewayUrl}/health`) : undefined,
  ]);
  if (!health.ok) {
    throw await platformProbeFailure('Health check', apiUrl, health, context);
  }
  if (!discovery.ok) {
    throw await platformProbeFailure('Discovery check', apiUrl, discovery, context);
  }
  const body = (await discovery.json()) as {
    installationId?: unknown;
    platformVersion?: unknown;
    usageProtocolVersion?: unknown;
  };
  if (body.installationId !== installationId) {
    throw new Error('platform: Deployed API discovery identity does not match this installation.');
  }
  if (body.platformVersion !== platformVersion) {
    throw new Error('platform: Deployed API discovery version does not match this release.');
  }
  if ((body.usageProtocolVersion ?? 0) !== usageProtocolVersion) {
    throw new Error(
      'platform: Deployed API usage protocol does not match this runtime. Traffic remains disabled.',
    );
  }
  if (!proxy.ok) {
    throw await platformProbeFailure('Proxy health check', proxyUrl, proxy, context);
  }
  if (!dispatch.ok) {
    throw await platformProbeFailure('Dispatch health check', dispatchUrl, dispatch, context);
  }
  if (emailGateway) {
    if (!emailGateway.ok) {
      throw await platformProbeFailure(
        'Email gateway health check',
        context!.emailGatewayUrl!,
        emailGateway,
        context,
      );
    }
    const identity = (await emailGateway.json()) as {
      installationId?: unknown;
      platformVersion?: unknown;
      emailProtocolVersion?: unknown;
    } | null;
    if (
      identity?.installationId !== installationId ||
      identity.platformVersion !== platformVersion ||
      identity.emailProtocolVersion !== 1
    ) {
      throw new Error(
        'platform: Deployed email gateway identity, version, or protocol does not match this installation.',
      );
    }
  }
}

export async function verifyPlatformSandboxDrain(
  apiUrl: string,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`${apiUrl}/internal/platform/sandbox-drain`, {
    headers: {
      'X-Void-Platform-Probe': healthProbeToken,
      ...cfAccessHeaders(process.env, apiUrl),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(
      `platform: Sandbox drain probe failed at ${apiUrl} (HTTP ${response.status}). Traffic remains disabled.`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      'platform: Sandbox drain probe did not return its DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'platform: Sandbox drain probe returned an invalid DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  const status = value as Record<string, unknown>;
  const validState =
    status.state === 'required' || status.state === 'draining' || status.state === 'complete';
  const validPhase =
    status.phase === null || status.phase === 'deployments' || status.phase === 'resources';
  if (
    status.version !== 1 ||
    !validState ||
    typeof status.complete !== 'boolean' ||
    !validPhase ||
    (status.generation !== null &&
      (typeof status.generation !== 'string' || status.generation.length === 0)) ||
    (status.updatedAt !== null &&
      (typeof status.updatedAt !== 'string' || !Number.isFinite(Date.parse(status.updatedAt)))) ||
    (status.state === 'required' &&
      (status.complete ||
        status.generation !== null ||
        status.updatedAt !== null ||
        status.phase !== null)) ||
    (status.state === 'draining' &&
      (status.complete ||
        typeof status.generation !== 'string' ||
        typeof status.updatedAt !== 'string' ||
        status.phase === null)) ||
    (status.state === 'complete' &&
      (!status.complete ||
        typeof status.generation !== 'string' ||
        typeof status.updatedAt !== 'string' ||
        status.phase === null))
  ) {
    throw new Error(
      'platform: Sandbox drain probe returned an invalid DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  return status.state === 'complete';
}

export async function bootstrapPlatformSharedEmail(
  apiUrl: string,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(`${apiUrl}/internal/platform/email-bootstrap`, {
    method: 'POST',
    headers: {
      'X-Void-Platform-Probe': healthProbeToken,
      ...cfAccessHeaders(process.env, apiUrl),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      `platform: Shared email bootstrap failed at ${apiUrl} (HTTP ${response.status}). Traffic remains disabled.`,
    );
  }
  const status =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !response.ok ||
    status?.version !== 1 ||
    status.state !== 'ready' ||
    typeof status.operationId !== 'string' ||
    status.operationId.length === 0
  ) {
    const detail =
      status && typeof status.operationId === 'string'
        ? ` Operation ${status.operationId}: ${typeof status.operationStatus === 'string' ? status.operationStatus : 'incomplete'}.`
        : status && typeof status.operationStatus === 'string'
          ? ` Operation status: ${status.operationStatus}.`
          : '';
    throw new Error(
      `platform: Shared email bootstrap did not reach inbound readiness at ${apiUrl} (HTTP ${response.status}).${detail} Traffic remains disabled.`,
    );
  }
  return status.operationId;
}

export function createPlatformHealthProbeToken(ownershipNonce: string): string {
  return createHash('sha256')
    .update('void-platform-health-probe:v1\0')
    .update(ownershipNonce)
    .digest('base64url');
}
