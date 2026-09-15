import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
  type CloudflareCommandRunner,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  createPlatformWorkerConfigs,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import { platformDatabaseSchemaDigest, resolvePlatformRuntime } from '@void/platform/installer';
import type {
  PlatformRuntime,
  PlatformRuntimeDatabaseManifest,
  PlatformRuntimeManifest,
  PlatformRuntimeMigration,
} from '@void/platform/installer';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
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
  promoteInstallationSecrets,
  savePlatformConnection,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import {
  platformManagedWorkerTraffic,
  recordPlatformWorkerTraffic,
  trackedPlatformWorkerTraffic,
} from './platform-traffic.ts';
import { resolveWranglerArgv } from './preset.ts';
import { createDefaultRunWrangler, resolvePinnedApiBaseUrl } from './provision.ts';

export const REMOTE_INSTALLATION_MANIFEST_KEY: string = PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY;

export type PlatformInstallationSecrets = Readonly<{
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  jwtSecret: string;
  projectSecretKey: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}>;

export type PlatformDatabaseLifecycleLock = (() => Promise<void>) & {
  authoritativeManifest?: PlatformInstallationManifest | null;
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
};

export type PlatformDatabaseState = Readonly<{
  pendingMigrations: ReadonlyArray<PlatformRuntimeMigration>;
  schemaDigest: string;
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
  deployWorker?: (
    config: Record<string, unknown>,
    secrets: Record<string, string> | null,
    previousConfig: Record<string, unknown>,
  ) => Promise<PlatformWorkerRollback | void>;
  migrateDatabase?: (databaseUrl: string, migrationsFolder: string) => Promise<void>;
  now?: () => string;
  prepareDatabase?: (
    runtimeDirectory: string,
    database: PlatformRuntimeDatabaseManifest,
    sourcePlatformVersion: string | null,
    hasPriorWorkers: boolean,
  ) => Promise<PlatformDatabaseMigrationResult>;
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
  verifyHealth?: (
    apiUrl: string,
    installationId: string,
    proxyUrl: string,
    applicationBaseDomain: string,
    platformVersion: string,
    healthProbeToken: string,
  ) => Promise<void>;
  verifyWorkerCutover?: (
    manifest: PlatformInstallationManifest,
    generation: number,
  ) => Promise<void>;
}>;

export type PlatformInstallationResult = Readonly<{
  manifest: PlatformInstallationManifest;
  waitingForDns: boolean;
  zoneNameServers: ReadonlyArray<string>;
}>;

export function loadPlatformRuntime(customRuntimeDirectory: string): PlatformRuntime {
  const runtime = resolvePlatformRuntime(customRuntimeDirectory || undefined);
  verifyRuntimeArtifacts(runtime.directory, runtime.manifest);
  return runtime;
}

export function createPlatformInstallationSecrets(input: {
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  existingInstallation?: boolean;
  jwtSecret?: string;
  projectSecretKey?: string;
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
  // Runtime signing/encryption keys are installation identity, not rotating
  // configuration. Once recovery material exists, an unrelated exported key
  // must never replace it during repair, upgrade, enable, or resume.
  const existingInstallation = input.existingInstallation === true;
  const restoredIdentity = (explicit: string, name: string): string =>
    existingInstallation ? checkpoint[name] || explicit || '' : explicit || checkpoint[name] || '';
  const configured = (explicit: string, name: string): string => explicit || checkpoint[name] || '';
  const jwtSecret = restoredIdentity(input.jwtSecret || '', 'jwtSecret');
  const projectSecretKey = restoredIdentity(input.projectSecretKey || '', 'projectSecretKey');
  const resolvedJwtSecret = input.existingInstallation
    ? jwtSecret
    : jwtSecret || randomBytes(32).toString('base64url');
  const resolvedProjectSecretKey = input.existingInstallation
    ? projectSecretKey
    : projectSecretKey || randomBytes(32).toString('base64');
  if (
    resolvedProjectSecretKey &&
    Buffer.from(resolvedProjectSecretKey, 'base64').byteLength !== 32
  ) {
    throw new Error(
      'platform: VOID_PLATFORM_PROJECT_SECRET_KEY must be a base64-encoded 32-byte key.',
    );
  }
  return {
    bootstrapGitHubId: existingInstallation
      ? configured(input.bootstrapGitHubId, 'bootstrapGitHubId')
      : required(
          configured(input.bootstrapGitHubId, 'bootstrapGitHubId'),
          'resolved administrator GitHub account id',
        ),
    bootstrapGitHubLogin: existingInstallation
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
    githubClientId: existingInstallation
      ? configured(input.githubClientId, 'githubClientId')
      : required(
          configured(input.githubClientId, 'githubClientId'),
          'VOID_PLATFORM_GITHUB_CLIENT_ID',
        ),
    githubClientSecret: existingInstallation
      ? configured(input.githubClientSecret, 'githubClientSecret')
      : required(
          configured(input.githubClientSecret, 'githubClientSecret'),
          'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
        ),
    jwtSecret: resolvedJwtSecret,
    projectSecretKey: resolvedProjectSecretKey,
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

function secretCheckpoint(secrets: PlatformInstallationSecrets): Record<string, string> {
  return {
    bootstrapGitHubId: secrets.bootstrapGitHubId,
    bootstrapGitHubLogin: secrets.bootstrapGitHubLogin,
    cloudflareApiToken: secrets.cloudflareApiToken,
    databaseUrl: secrets.databaseUrl,
    githubClientId: secrets.githubClientId,
    githubClientSecret: secrets.githubClientSecret,
    jwtSecret: secrets.jwtSecret,
    projectSecretKey: secrets.projectSecretKey,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2SecretAccessKey: secrets.r2SecretAccessKey,
  };
}

export async function installPlatform(
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  existing: PlatformInstallationManifest | null,
  dependencies: PlatformInstallerDependencies,
): Promise<PlatformInstallationResult> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const cloudflareApiBaseUrl = dependencies.client.apiBaseUrl ?? resolvePinnedApiBaseUrl();
  const runPinnedPlatformWrangler: typeof runPlatformWrangler = (args, accountId, cwd, capture) =>
    runPlatformWranglerAtApiBase(args, accountId, cwd, capture, cloudflareApiBaseUrl);
  const resolvedRuntime = dependencies.runtime ?? resolvePlatformRuntime();
  const runtimeDirectory = resolvedRuntime.directory;
  const runtime = resolvedRuntime.manifest;
  verifyRuntimeArtifacts(runtimeDirectory, runtime);
  const runtimeProvenance = {
    manifestSha256: resolvedRuntime.manifestSha256,
    source: resolvedRuntime.source,
    sourceRevision: runtime.sourceRevision,
  } as const;
  const version = runtime.platformVersion;
  const sourcePlatformVersion = existing?.platformVersion ?? null;
  const hadPriorWorkers =
    existing !== null &&
    (existing.resources.some(
      (resource) => resource.kind === 'worker' && resource.state === 'ready',
    ) ||
      plan.actions.some((action) => action.kind === 'worker' && action.action !== 'create'));
  const wasDisabled = existing?.status === 'disabled';
  const preserveDisabled = existing?.desiredState === 'disabled';
  const previousPublicEndpoints = stablePublicEndpointState(existing);
  let workerCutoverGeneration = 0;
  let workerRollbacks: Array<PlatformWorkerRollback> = [];
  let workerDeploymentCommitted = false;
  let workerTrafficGuarded = false;
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
  if (preserveDisabled && manifest.desiredState !== 'disabled') {
    manifest = setInstallationDesiredState(manifest, 'disabled', now());
    writeInstallationManifest(manifest);
  }
  assertRequiredPlatformSecrets(plan, manifest, secrets);
  const pendingSecrets = secretCheckpoint(secrets);
  writePendingInstallationSecrets(manifest, {
    ...pendingSecrets,
    databaseClaimState: 'claiming',
  });

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
    if (existing) {
      await dependencies.verifyExistingOwnership?.(
        manifest,
        authoritative !== null && authoritative !== undefined,
      );
    }
    if (JSON.stringify(manifest.deployment) !== JSON.stringify(plan.deployment)) {
      manifest = { ...manifest, deployment: plan.deployment, updatedAt: now() };
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
    }
    await releaseDatabaseLock.checkpoint?.(manifest);
    if (manifest.status !== 'provisioning') {
      manifest = transitionInstallation(manifest, 'provisioning', now());
      writeInstallationManifest(manifest);
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

    const zoneAction = plan.actions.find((action) => action.key === 'zone')!;
    let zone = plan.zone;
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
      return { manifest, waitingForDns: true, zoneNameServers: zone.nameServers };
    }

    for (const action of plan.actions.filter(
      (entry) => entry.key !== 'routing-kv' && entry.kind !== 'zone' && entry.kind !== 'worker',
    )) {
      const retainedManifest = retainReplacedInstallationResource(manifest, action, now());
      if (retainedManifest !== manifest) {
        manifest = retainedManifest;
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      }
      if (action.action === 'adopt') {
        if (!action.id) {
          throw new Error(`platform: Adopted ${action.kind} ${action.name} has no id.`);
        }
        manifest = recordAdoptionIntent(manifest, action, action.id, now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        manifest = recordResource(
          manifest,
          action,
          action.id,
          'adopted',
          now(),
          secrets.databaseUrl,
        );
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
          );
          writeInstallationManifest(manifest);
          await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
          await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        }
        continue;
      }
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      const resource = await createResource(
        dependencies.client,
        plan,
        action,
        secrets.databaseUrl,
        zone.id,
      );
      manifest = recordResource(
        manifest,
        action,
        resource.id,
        'created',
        now(),
        secrets.databaseUrl,
        resource.fingerprint,
      );
      writeInstallationManifest(manifest);
      await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    const migrationStep = `database-schema:${runtime.database.schemaDigest}`;
    if (!manifest.steps.some((step) => step.key === migrationStep)) {
      const legacyMigrationStep = `database-migrations:${runtime.database.journalSha256}`;
      if (dependencies.migrateDatabase) {
        if (!manifest.steps.some((step) => step.key === legacyMigrationStep)) {
          await dependencies.migrateDatabase(
            secrets.databaseUrl,
            join(runtimeDirectory, 'drizzle'),
          );
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
          resultHash: hash(secrets.bootstrapGitHubId),
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
    ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string>;
    const interruptedCutover = interruptedWorkerCutover(manifest);
    const recoveringUnsafeTraffic = (interruptedCutover?.unsafeTraffic.size ?? 0) > 0;
    const createsWorker = plan.actions.some(
      (action) => action.kind === 'worker' && action.action === 'create',
    );
    const recoveringCreatedWorker =
      interruptedCutover !== null &&
      [...interruptedCutover.staged.values()].some(
        (snapshot) => snapshot.previousVersionId === null,
      );
    const requiresTrafficGuard =
      !previousPublicEndpoints ||
      recoveringUnsafeTraffic ||
      createsWorker ||
      recoveringCreatedWorker;
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
      accountId: plan.account.id,
      apiUrl: plan.apiUrl,
      deployment: plan.deployment,
      healthProbeToken: createPlatformHealthProbeToken(manifest.ownershipNonce),
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      platformVersion: version,
      proxyUrl: plan.proxyUrl,
      resources: {
        hyperdrive: requireId(ids, 'hyperdrive'),
        isrCacheKv: requireId(ids, 'isr-cache-kv'),
        legacyAssetsKv: requireId(ids, 'legacy-assets-kv'),
        routingKv: requireId(ids, 'routing-kv'),
        zone: zone.id,
      },
      runtimeEntrypoints: entrypoints,
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
          trafficState: 'staging',
        })
      : enabledConfigs;
    const previousConfigs = createPlatformWorkerConfigs({
      ...configInput,
      publicEndpoints: previousPublicEndpoints,
      trafficState: previousPublicEndpoints ? 'enabled' : 'staging',
    });
    const managedRoutes = platformManagedWorkerTraffic(plan.deployment).routes;
    let workerActions: ReadonlyArray<PlatformInstallPlanAction> = plan.actions.filter(
      (action) => action.kind === 'worker',
    );
    if (interruptedCutover) {
      for (const key of [...interruptedCutover.staged.keys()].reverse()) {
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
          const previousRecoveryTraffic =
            isolatePlatformWorkerCustomDomains(previousRecoveryConfig);
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
                `${key}-worker`,
                snapshot.workerName,
              ),
            removeCustomDomains: async () => {
              if (!dependencies.client.removeRoutes) {
                throw new Error('platform: Cloudflare route removal is unavailable.');
              }
              await dependencies.client.removeRoutes(
                plan.account.id,
                zone.id,
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
        );
      }
    }
    workerCutoverGeneration = nextWorkerCutoverGeneration(manifest);
    for (const key of ['api', 'proxy', 'tail', 'dispatch'] as const) {
      const action = workerActions.find((entry) => entry.key === `${key}-worker`)!;
      const workerSecrets =
        key === 'api'
          ? apiWorkerSecrets(secrets, plan.account.id, zone.id)
          : key === 'proxy'
            ? proxyWorkerSecrets(secrets, plan.account.id)
            : null;
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      await dependencies.revalidateBeforeWorkerDeploy(manifest, action);
      const preservedRoutes = dependencies.deployWorker
        ? []
        : action.action === 'create'
          ? []
          : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
      const workerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
      const previousWorkerConfig = mergePlatformWorkerTrafficConfig(
        previousConfigs[key],
        preservedRoutes,
      );
      const rollback = dependencies.deployWorker
        ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
        : await deployPlatformWorker(workerConfig, workerSecrets, {
            apiBaseUrl: cloudflareApiBaseUrl,
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
              if (!dependencies.client.listWorkerDomains || !dependencies.client.listWorkerRoutes) {
                throw new Error('platform: Cloudflare traffic inventory is unavailable.');
              }
              const [customDomains, routes] = await Promise.all([
                dependencies.client.listWorkerDomains(plan.account.id),
                dependencies.client.listWorkerRoutes(zone.id),
              ]);
              manifest = recordPlatformWorkerTraffic(
                manifest!,
                action.name,
                { customDomains, routes },
                now(),
              );
              writeInstallationManifest(manifest);
              await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
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
              await dependencies.client.publishWorkerRoutesSafely(zone.id, workerName, patterns);
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
                zone.id,
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
            runner: runPinnedPlatformWrangler,
            workerExisted: action.action !== 'create',
          });
      if (rollback) {
        workerRollbacks.push(rollback);
      }
      manifest = recordResource(manifest, action, action.name, 'created', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
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
      manifest = {
        ...manifest,
        platformVersion: version,
        runtime: runtimeProvenance,
        updatedAt: now(),
      };
      manifest = transitionInstallation(manifest, 'disabled', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      promoteInstallationSecrets(manifest);
      saveInstalledPlatformConnection(plan, manifest);
      return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
    }
    manifest = transitionInstallation(manifest, 'verifying', now());
    writeInstallationManifest(manifest);
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(
      plan.apiUrl,
      manifest.id,
      plan.proxyUrl,
      plan.deployment.application.baseDomain,
      version,
      createPlatformHealthProbeToken(manifest.ownershipNonce),
    );
    if (requiresStagedCommit) {
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

      workerCutoverGeneration = nextWorkerCutoverGeneration(manifest);
      for (const key of ['api', 'proxy', 'tail', 'dispatch'] as const) {
        const action = workerActions.find((entry) => entry.key === `${key}-worker`)!;
        const workerSecrets =
          key === 'api'
            ? apiWorkerSecrets(secrets, plan.account.id, zone.id)
            : key === 'proxy'
              ? proxyWorkerSecrets(secrets, plan.account.id)
              : null;
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
                  dependencies.client.listWorkerRoutes(zone.id),
                ]);
                manifest = recordPlatformWorkerTraffic(
                  manifest!,
                  action.name,
                  { customDomains, routes },
                  now(),
                );
                writeInstallationManifest(manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
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
                await dependencies.client.publishWorkerRoutesSafely(zone.id, workerName, patterns);
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
                  zone.id,
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
        );
      }
    };
    await verifyCurrentWorkerCutover();
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
      await (dependencies.verifyHealth ?? verifyPlatformHealth)(
        plan.apiUrl,
        manifest.id,
        plan.proxyUrl,
        plan.deployment.application.baseDomain,
        version,
        createPlatformHealthProbeToken(manifest.ownershipNonce),
      );
      await verifyCurrentWorkerCutover();
    }
    workerDeploymentCommitted = true;
    manifest = recordWorkerCutoverResolution(manifest, workerCutoverGeneration, 'committed', now());
    manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, true, now());
    manifest = {
      ...manifest,
      platformVersion: version,
      runtime: runtimeProvenance,
      updatedAt: now(),
    };
    manifest = transitionInstallation(manifest, 'installed', now());
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    workerTrafficGuarded = false;
    promoteInstallationSecrets(manifest);
    saveInstalledPlatformConnection(plan, manifest);
    return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
  } catch (error) {
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
    if (!workerDeploymentCommitted && workerRollbacks.length > 0) {
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
    throw failure;
  } finally {
    await releaseDatabaseLock();
  }
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
  await databaseLock?.checkpoint?.(manifest);
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
  await client.putKvValue(
    plan.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
    JSON.stringify(manifest),
  );
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

function recordResource(
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
    JWT_SECRET: secrets.jwtSecret,
    PLATFORM_BOOTSTRAP_GITHUB_ID: secrets.bootstrapGitHubId,
    ...(secrets.projectSecretKey
      ? {
          PROJECT_SECRET_ACTIVE_KEY_VERSION: 'v1',
          PROJECT_SECRET_KEYS_JSON: JSON.stringify({ v1: secrets.projectSecretKey }),
        }
      : {}),
    R2_ACCESS_KEY_ID: secrets.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: secrets.r2SecretAccessKey,
  });
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
): void {
  const missing = new Set<string>();
  const requireSecret = (value: string, name: string) => {
    if (!value) {
      missing.add(name);
    }
  };
  if (!manifest.steps.some((step) => step.key === 'bootstrap-access:v1')) {
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
    requireSecret(secrets.githubClientId, 'VOID_PLATFORM_GITHUB_CLIENT_ID');
    requireSecret(secrets.githubClientSecret, 'VOID_PLATFORM_GITHUB_CLIENT_SECRET');
    requireSecret(secrets.jwtSecret, 'VOID_PLATFORM_JWT_SECRET');
    requireSecret(secrets.projectSecretKey, 'VOID_PLATFORM_PROJECT_SECRET_KEY');
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
  }
  if (missing.size > 0) {
    throw new Error(
      `platform: Creating a missing platform Worker requires: ${[...missing].sort().join(', ')}. Restore these values from your secret manager and retry.`,
    );
  }
}

export async function claimPlatformDatabase(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
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
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
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
    release.authoritativeManifest = releaseConnectionLock.authoritativeManifest;
    release.checkpoint = releaseConnectionLock.checkpoint;
    release.prepareDatabase = releaseConnectionLock.prepareDatabase;
    return release;
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
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
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
  return release;
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
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
}>;

async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  options: PlatformWorkerDeploymentOptions,
): Promise<PlatformWorkerRollback> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  let activatedVersionId: string | null = null;
  let activatedDeploymentId: string | null = null;
  let uploadedVersionId: string | null = null;
  let previousDeployment: PlatformWorkerDeployment | null = null;
  let previousDeploymentId: string | null = null;
  let previousVersionId: string | null = null;
  const nextTraffic = isolatePlatformWorkerCustomDomains(config);
  const previousTraffic = isolatePlatformWorkerCustomDomains(options.previousConfig);
  const uploadConfig = withoutPlatformWorkerTrafficAttachments(nextTraffic.wranglerConfig);
  const nextTriggers = readTriggerConfigFromObject(nextTraffic.wranglerConfig);
  let previousTriggers = readTriggerConfigFromObject(previousTraffic.wranglerConfig);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    if (options.workerExisted) {
      const previous = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        workerName,
        readPlatformWorkerOwnershipMarker(config),
        options.runner,
      );
      previousVersionId = previous.versionId;
      const deployments = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        options.runner,
      );
      if (!deploymentRunsOnlyVersion(deployments[0], previousVersionId)) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      previousDeployment = deployments[0]!;
      previousDeploymentId = previousDeployment.id;
      previousTriggers = resolvePlatformPreviousTriggerConfig(
        withoutPlatformCustomDomainTriggers(previous.triggerConfig),
        previousTriggers,
        options.previousPublicEndpoints,
      );
      previousTriggers = withoutPlatformCustomDomainTriggers(
        mergePreservedTriggerRoutes(previousTriggers, options.preservedRoutes),
      );
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
      encodeCloudflareVersionMessage([], nextTriggers),
    ];
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      argv.push('--secrets-file', secretsPath);
    }
    const uploaded = options.workerExisted
      ? await options.runner(argv, accountId, directory, true)
      : await runPlatformWranglerForConditionalCreate(
          argv,
          accountId,
          directory,
          true,
          workerName,
          options.apiBaseUrl,
        );
    uploadedVersionId = parseUploadedPlatformWorkerVersion(
      `${uploaded.stdout}\n${uploaded.stderr}`,
    );
    if (!options.workerExisted) {
      activatedVersionId = uploadedVersionId;
    }
    assertCleanPlatformWrangler(
      uploaded,
      `${options.workerExisted ? 'upload' : 'bootstrap'} ${workerName}`,
    );
    if (!uploadedVersionId) {
      throw new Error(
        `platform: Wrangler uploaded ${workerName} without reporting its immutable version id.`,
      );
    }
    await options.onStaged(previousVersionId, uploadedVersionId, previousTriggers);
    if (options.workerExisted) {
      const deploymentsBeforeActivation = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        options.runner,
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
      options.runner,
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
          runner: options.runner,
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
      runWrangler: platformWorkerCommandRunner(accountId, directory, options.runner),
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
        runner: options.runner,
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
              runner: options.runner,
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

async function runPlatformWrangler(
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
): Promise<CloudflareCommandResult> {
  const runner = createDefaultRunWrangler(process.cwd(), {
    launcher: resolveWranglerArgv(process.cwd()),
    timeoutMs: PLATFORM_WRANGLER_TIMEOUT_MS,
  });
  const result = await runner([...args], {
    accountId,
    apiBaseUrl,
    captureJson: capture,
    cwd,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (!capture) {
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
  const expectedPath = `${basePath}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  const state: ConditionalWorkerCreateState = {
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
      const isConditionalCreate =
        incoming.method === 'PUT' &&
        incomingUrl.pathname === expectedPath &&
        incomingUrl.search === '';
      const isTopLevelWorkerUpload =
        incoming.method === 'PUT' &&
        new RegExp(
          `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/accounts/[^/]+/workers/scripts/[^/]+$`,
        ).test(incomingUrl.pathname);
      const isReadOnly =
        incoming.method === 'GET' || incoming.method === 'HEAD' || incoming.method === 'OPTIONS';
      if (
        (isTopLevelWorkerUpload && !isConditionalCreate) ||
        (!isReadOnly && !isConditionalCreate && !state.created)
      ) {
        state.rejectedMutation = `${incoming.method ?? 'UNKNOWN'} ${incomingUrl.pathname}`;
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
): Promise<{ triggerConfig: CloudflareTriggerConfig; versionId: string }> {
  const readActiveVersion = () =>
    readActivePlatformWorkerVersion(configPath, accountId, workerName, runner);
  const versionId = await readActiveVersion();
  if (!versionId) {
    throw new Error(
      `platform: Existing Worker ${workerName} has no single active production version.`,
    );
  }
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
  if ((await readActiveVersion()) !== versionId) {
    throw new Error(
      `platform: Worker ${workerName} changed concurrently while its active version was inspected.`,
    );
  }
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
  return { triggerConfig: metadata.triggerConfig, versionId };
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
  for (const artifact of Object.values(manifest.artifacts)) {
    const path = join(runtimeDirectory, artifact.path);
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch (error) {
      throw new Error(`platform: Runtime Worker artifact is missing: ${errorMessage(error)}`);
    }
    if (contents.byteLength !== artifact.size || hash(contents) !== artifact.sha256) {
      throw new Error(`platform: Runtime Worker artifact failed integrity verification: ${path}.`);
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

type PlatformWorkerKey = 'api' | 'proxy' | 'tail' | 'dispatch';

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
  return (
    Math.max(
      0,
      ...manifest.steps.flatMap((step) => {
        const match = /^worker-(?:cutover|traffic-state):(\d+)/.exec(step.key);
        return match ? [Number(match[1])] : [];
      }),
    ) + 1
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
    const unsafeTraffic = /^worker-cutover:(\d+):unsafe-traffic:(api|proxy|tail|dispatch)$/.exec(
      step.key,
    );
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
    const staged = /^worker-cutover:(\d+):staged:(api|proxy|tail|dispatch)$/.exec(step.key);
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
): Promise<void> {
  const cutover = interruptedWorkerCutover(manifest);
  if (cutover?.generation !== generation || cutover.staged.size !== 4) {
    throw new Error(
      `platform: Worker cutover generation ${generation} is missing a complete immutable-version checkpoint.`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-cutover-verify-'));
  try {
    for (const key of ['api', 'proxy', 'tail', 'dispatch'] as const) {
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

export async function verifyPlatformHealth(
  apiUrl: string,
  installationId: string,
  proxyUrl: string,
  applicationBaseDomain: string,
  platformVersion: string,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const request = (url: string) =>
    fetcher(url, {
      headers: {
        'X-Void-Platform-Probe': healthProbeToken,
        ...cfAccessHeaders(process.env, url),
      },
      signal: AbortSignal.timeout(30_000),
    });
  const [health, discovery, proxy, dispatch] = await Promise.all([
    request(`${apiUrl}/health`),
    request(`${apiUrl}/.well-known/void-platform`),
    request(`${proxyUrl}/health`),
    request(`https://test.${applicationBaseDomain}/health`),
  ]);
  if (!health.ok) {
    throw new Error(`platform: Health check failed at ${apiUrl} (HTTP ${health.status}).`);
  }
  if (!discovery.ok) {
    throw new Error(`platform: Discovery check failed at ${apiUrl} (HTTP ${discovery.status}).`);
  }
  const body = (await discovery.json()) as {
    installationId?: unknown;
    platformVersion?: unknown;
  };
  if (body.installationId !== installationId) {
    throw new Error('platform: Deployed API discovery identity does not match this installation.');
  }
  if (body.platformVersion !== platformVersion) {
    throw new Error('platform: Deployed API discovery version does not match this release.');
  }
  if (!proxy.ok) {
    throw new Error(`platform: Proxy health check failed at ${proxyUrl} (HTTP ${proxy.status}).`);
  }
  if (!dispatch.ok) {
    throw new Error(
      `platform: Dispatch health check failed at https://test.${applicationBaseDomain} (HTTP ${dispatch.status}).`,
    );
  }
}

export function createPlatformHealthProbeToken(ownershipNonce: string): string {
  return createHash('sha256')
    .update('void-platform-health-probe:v1\0')
    .update(ownershipNonce)
    .digest('base64url');
}
