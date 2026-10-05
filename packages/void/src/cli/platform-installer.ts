import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPlatformInstallationManifest,
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationStep,
  setInstallationDesiredState,
  setInstallationEndpoints,
  platformDashboardUrl,
  transitionInstallation,
  type PlatformInstallationManifest,
  type PlatformLifecycleOperation,
} from '@void/platform';
import { PLATFORM_ADMIN_ASSETS_DIRECTORY, resolvePlatformRuntime } from '@void/platform/installer';
import { join } from 'pathslash';
import { ensurePlatformAccessToken } from './cf-access.ts';
import {
  initializeInstalledAppAccess,
  PlatformAppAccessCredentialError,
} from './platform-app-access.ts';
import {
  initializeInstalledPlatformAuthentication,
  resumeInstalledPlatformAuthentication,
} from './platform-auth-bootstrap.ts';
import { verifyExternalPlatformHyperdrive } from './platform-auth-database.ts';
import { parsePostgresConnectionString } from './platform-cloudflare.ts';
import { enableInstallationServices } from './platform-install-activation.ts';
import { prepareInstallationAuthentication } from './platform-install-preparation.ts';
import { provisionInstallationServices } from './platform-install-provisioning.ts';
import { uploadInstallationWorkers } from './platform-install-workers.ts';
import {
  assertVoidCreatedHyperdriveTrustsDatabase,
  claimPlatformDatabase,
  assertPlatformRuntimeSafety,
} from './platform-installer-database.ts';
import { verifyPlatformHealth, verifyPlatformSandboxDrain } from './platform-installer-health.ts';
import {
  requireId,
  writeRemoteInstallationCheckpointWithoutDatabase,
  hash,
  saveInstalledPlatformConnection,
} from './platform-installer-resources.ts';
import { verifyRuntimeArtifacts } from './platform-installer-runtime.ts';
import {
  sanitizeWorkerSecretUpdates,
  assertRequiredPlatformSecrets,
  secretCheckpoint,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';
import {
  type PlatformInstallerDependencies,
  type PlatformWorkerRollback,
  type InstallationCheckpointWriter,
  PlatformWorkerRecoveryIncompleteError,
  type PlatformInstallationSecrets,
  type PlatformInstallationResult,
  type PlatformWorkerKey,
  type PlatformWorkerSecretUpdateIntent,
  type InstallerClient,
  type PlatformHealthCheckContext,
} from './platform-installer-types.ts';
import {
  errorMessage,
  recordWorkerCutoverResolution,
  recordWorkerTrafficState,
  runPlatformWrangler,
  runPlatformWranglerAtApiBase,
  stablePublicEndpointState,
  interruptedWorkerCutover,
  nextTrafficGeneration,
  recoverInterruptedPlatformWorkerCutover,
  nextWorkerCutoverGeneration,
  recordWorkerSecretUpdateState,
} from './platform-installer-workers.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import {
  latestPlatformWorkerCutoverGeneration,
  platformWorkerSecretUpdateIntentState,
  promoteInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import { assertPlatformWorkerSecretUpdateAuthority } from './platform-secret-update-authority.ts';
import { platformManagedWorkerTraffic } from './platform-traffic.ts';
import { resolvePinnedApiBaseUrl } from './provision.ts';

export { PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY as REMOTE_INSTALLATION_MANIFEST_KEY } from '@void/platform';

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
  operationStarted: boolean,
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
  if (manifest.status !== 'uninstalled' && (manifest.status !== 'failed' || operationStarted)) {
    try {
      const updatedAt = now();
      manifest = transitionInstallation(manifest, 'failed', updatedAt);
      if (operationStarted && manifest.operation) {
        manifest = {
          ...manifest,
          operation: { ...manifest.operation, phase: 'failed', updatedAt },
        };
      }
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
  const runPinnedPlatformWrangler: typeof runPlatformWrangler = (
    operation,
    accountId,
    cwd,
    capture,
  ) => runPlatformWranglerAtApiBase(operation, accountId, cwd, capture, cloudflareApiBaseUrl);
  const runParallelPinnedPlatformWrangler: typeof runPlatformWrangler = (
    operation,
    accountId,
    cwd,
    capture,
  ) => runPlatformWranglerAtApiBase(operation, accountId, cwd, capture, cloudflareApiBaseUrl, true);
  const resolvedRuntime = dependencies.runtime ?? resolvePlatformRuntime();
  const runtimeDirectory = resolvedRuntime.directory;
  const runtime = resolvedRuntime.manifest;
  if (plan.deployment.appAccess && runtime.appAccessSetup !== 1) {
    throw new Error('platform: This runtime does not support the installation’s app access setup.');
  }
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
  if (plan.externalHyperdrive) {
    secrets = { ...secrets, externalHyperdriveJson: JSON.stringify(plan.externalHyperdrive) };
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
  // Progress is checkpointed under the same lifecycle lock as mutations. Do not
  // update it from parallel Worker upload callbacks.
  const checkpointOperation = async (phase: PlatformLifecycleOperation['phase']) => {
    if (!manifest?.operation) {
      return;
    }
    const updatedAt = now();
    manifest = { ...manifest, operation: { ...manifest.operation, phase, updatedAt }, updatedAt };
    writeInstallationManifest(manifest);
    await releaseDatabaseLock.checkpoint?.(manifest);
  };
  let operationStarted = false;
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
    const action = dependencies.operation ?? (existing ? 'upgrade' : 'install');
    const previousOperation = manifest.operation;
    const resuming =
      previousOperation?.action === action &&
      previousOperation.toVersion === version &&
      previousOperation.runtimeManifestSha256 === resolvedRuntime.manifestSha256 &&
      previousOperation.phase !== 'complete';
    const startedAt = now();
    operationStarted = true;
    manifest = {
      ...manifest,
      operation: {
        id: resuming ? previousOperation.id : randomUUID(),
        action,
        fromVersion: resuming ? previousOperation.fromVersion : sourcePlatformVersion,
        toVersion: version,
        runtimeManifestSha256: resolvedRuntime.manifestSha256,
        phase: 'preparing',
        startedAt: resuming ? previousOperation.startedAt : startedAt,
        updatedAt: startedAt,
      },
      updatedAt: startedAt,
    };
    await checkpointOperation('preparing');
    await prepareInstallationAuthentication({
      releaseDatabaseLock,
      get authenticationEnforcementActive() {
        return authenticationEnforcementActive!;
      },
      set authenticationEnforcementActive(value: boolean) {
        authenticationEnforcementActive = value;
      },
      runtime,
      get plan() {
        return plan!;
      },
      set plan(value: PlatformInstallPlan) {
        plan = value;
      },
      authenticationProtocolTransition,
      get manifest() {
        return manifest!;
      },
      set manifest(value: PlatformInstallationManifest) {
        manifest = value;
      },
      get secrets() {
        return secrets!;
      },
      set secrets(value: PlatformInstallationSecrets) {
        secrets = value;
      },
      now,
      dependencies,
      workerSecretUpdateIntent,
    });

    // Establish the durable installation checkpoint before creating any
    // resource that may need to be reconciled or removed after interruption.
    const provisionInstallationServicesResult = await provisionInstallationServices({
      plan,
      get manifest() {
        return manifest!;
      },
      set manifest(value: PlatformInstallationManifest) {
        manifest = value;
      },
      now,
      releaseDatabaseLock,
      dependencies,
      secrets,
      writeRemoteInstallationCheckpoint,
      checkpointOperation,
      externalHyperdriveOriginHash,
      runtime,
      runtimeDirectory,
      sourcePlatformVersion,
      hadPriorWorkers,
    });
    if ('waitingForDns' in provisionInstallationServicesResult) {
      return provisionInstallationServicesResult;
    }
    const zone = provisionInstallationServicesResult.zone;
    const zoneId = provisionInstallationServicesResult.zoneId;
    const targetSandboxDrainProtocol =
      provisionInstallationServicesResult.targetSandboxDrainProtocol;
    const prepareSandboxDrain = provisionInstallationServicesResult.prepareSandboxDrain;
    const sandboxDrainState = provisionInstallationServicesResult.sandboxDrainState;
    const ids = provisionInstallationServicesResult.ids;
    const entrypoints = provisionInstallationServicesResult.entrypoints;
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
      requiresSandboxDrain ||
      (!!plan.deployment.appAccess &&
        !manifest.steps.some((step) => step.key === 'app-access-initialized:v1'));
    if (requiresTrafficGuard) {
      await dependencies.client.putKvValue(
        plan.account.id,
        requireId(ids, 'routing-kv'),
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
      workerTrafficGuarded = true;
      dependencies.onProgress?.('Application traffic paused for a safe platform cutover');
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
      proxyHealthBinding: true,
      accountId: plan.account.id,
      apiUrl: plan.apiUrl,
      deployment: plan.deployment,
      deploymentExecution: runtime.deploymentExecution,
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
    // Preparation can generate new setup credentials. Snapshot only after all
    // preparation has completed so the deployed API can verify the handoff.
    const workerDeploymentSecrets: PlatformInstallationSecrets = {
      ...secrets,
      workerSecretUpdates: workerSecretUpdateIntent?.updates ?? {},
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
    await uploadInstallationWorkers({
      dependencies,
      requiresStagedCommit,
      workerSecretUpdateIntent,
      recoveringUnsafeTraffic,
      workerActions,
      workerKeys,
      workerDeploymentSecrets,
      plan,
      zoneId,
      get manifest() {
        return manifest!;
      },
      set manifest(value: PlatformInstallationManifest) {
        manifest = value;
      },
      now,
      writeRemoteInstallationCheckpoint,
      configs,
      previousConfigs,
      cloudflareApiBaseUrl,
      workerCutoverGeneration,
      preserveDisabled,
      managedRoutes,
      previousPublicEndpoints,
      ids,
      runParallelPinnedPlatformWrangler,
      runPinnedPlatformWrangler,
      workerRollbacks,
    });

    manifest = setInstallationEndpoints(
      manifest,
      {
        apiUrl: plan.apiUrl,
        dashboardUrl: platformDashboardUrl(plan.deployment),
        proxyUrl: plan.proxyUrl,
      },
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
        deploymentExecution: runtime.deploymentExecution,
        platformVersion: version,
        runtime: runtimeProvenance,
        updatedAt: now(),
        usageProtocolVersion: targetUsageProtocolVersion,
      };
      manifest = transitionInstallation(manifest, 'disabled', now());
      await checkpointOperation('complete');
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
    await checkpointOperation('verifying');
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
    if (
      plan.deployment.appAccess &&
      !manifest.steps.some((step) => step.key === 'app-access-initialized:v1')
    ) {
      dependencies.onProgress?.('Configuring and verifying deployed-app access');
      try {
        await (dependencies.initializeAppAccess ?? initializeInstalledAppAccess)({
          apiUrl: plan.apiUrl,
          installationId: manifest.id,
          probeToken: createPlatformHealthProbeToken(manifest.ownershipNonce),
          setupJson: secrets.appAccessSetupJson!,
          setupToken: secrets.appAccessSetupToken!,
        });
      } catch (error) {
        if (error instanceof PlatformAppAccessCredentialError) {
          secrets = {
            ...secrets,
            authenticationPreparation: {
              ...secrets.authenticationPreparation,
              appAccessTokenRejected: 'true',
            },
          };
          writePendingInstallationSecrets(
            manifest,
            secretCheckpoint(secrets, workerSecretUpdateIntent),
          );
        }
        throw error;
      }
      manifest = recordInstallationStep(
        manifest,
        {
          key: 'app-access-initialized:v1',
          completedAt: now(),
          resultHash: hash(secrets.appAccessSetupJson!),
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
      ...(plan.deployment.authentication.accessProtection ? { accessProtected: true } : {}),
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
        await checkpointOperation('waiting-for-sandbox-drain');
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
    }
    const enableInstallationServicesResult = await enableInstallationServices({
      checkpointOperation,
      requiresStagedCommit,
      authenticationCutoverCommitted,
      get manifest() {
        return manifest!;
      },
      set manifest(value: PlatformInstallationManifest) {
        manifest = value;
      },
      get workerCutoverGeneration() {
        return workerCutoverGeneration!;
      },
      set workerCutoverGeneration(value: number) {
        workerCutoverGeneration = value;
      },
      now,
      writeRemoteInstallationCheckpoint,
      dependencies,
      plan,
      get workerRollbacks() {
        return workerRollbacks!;
      },
      set workerRollbacks(value: Array<PlatformWorkerRollback>) {
        workerRollbacks = value;
      },
      get workerSecretUpdateIntent() {
        return workerSecretUpdateIntent!;
      },
      set workerSecretUpdateIntent(value: PlatformWorkerSecretUpdateIntent | null) {
        workerSecretUpdateIntent = value;
      },
      secrets,
      workerKeys,
      workerActions,
      workerDeploymentSecrets,
      zoneId,
      enabledConfigs,
      configs,
      cloudflareApiBaseUrl,
      managedRoutes,
      ids,
      runPinnedPlatformWrangler,
      shouldBootstrapSharedEmail,
      get workerDeploymentCommitted() {
        return workerDeploymentCommitted!;
      },
      set workerDeploymentCommitted(value: boolean) {
        workerDeploymentCommitted = value;
      },
      releaseDatabaseLock,
      wasDisabled,
      previousPublicEndpoints,
      version,
      targetUsageProtocolVersion,
      healthCheckContext,
      runtime,
      runtimeProvenance,
    });
    const emailOperationId = enableInstallationServicesResult.emailOperationId;
    await checkpointOperation('complete');
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
      operationStarted,
      now,
      writeRemoteInstallationCheckpoint,
    );
  } finally {
    await releaseDatabaseLock();
  }
}

export {
  type PlatformInstallationSecrets,
  type PlatformDatabaseLifecycleLock,
  mergePlatformLiveAuthenticationDeployment,
  type PlatformDatabaseState,
  type PlatformSandboxDrainPreparation,
  type PlatformDatabaseMigrationResult,
  PlatformWorkerRecoveryIncompleteError,
  type PlatformInstallerDependencies,
  type PlatformInstallationResult,
  type PlatformWorkerDeployment,
  type PlatformHealthCheckContext,
} from './platform-installer-types.ts';

export {
  createPlatformInstallationSecrets,
  apiWorkerSecrets,
  platformWorkerSecretPayload,
  resolveBootstrapGitHubId,
  assertRequiredPlatformSecrets,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';

export {
  recordResource,
  r2BucketConfigHash,
  retainReplacedInstallationResource,
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
  mergePreservedTriggerRoutes,
  isolatePlatformWorkerCustomDomains,
  withoutPlatformWorkerTrafficAttachments,
} from './platform-installer-resources.ts';

export {
  platformDatabaseClientUrl,
  claimPlatformDatabase,
  acquirePlatformDatabaseLifecycleLock,
  readPlatformDatabaseLifecycleManifest,
  readPlatformProjectSlugs,
  readPlatformProjectZeroTrustState,
  inspectPlatformDatabaseStateConnection,
  preparePlatformDatabaseConnection,
  readPlatformDatabaseLifecycleManifestConnection,
  acquirePlatformDatabaseLifecycleLockConnection,
  preparePlatformSandboxDrainConnection,
  verifyPlatformDatabaseConnection,
  assertPlatformRuntimeSafety,
  claimPlatformDatabaseConnection,
} from './platform-installer-database.ts';

export {
  platformWorkerUploadFingerprint,
  deployPlatformWorker,
  recoverFailedPlatformWorkerDeployment,
  runPlatformWrangler,
  withConditionalPlatformWorkerCreate,
  readPlatformWorkerDeployments,
  restorePlatformWorkerDeployment,
  classifyPlatformWorkerDeploymentLineage,
  inspectNewPlatformWorker,
  readActivePlatformWorkerSnapshot,
  withoutCompletedPlatformWorkerMigrations,
  verifyPlatformWorkerCutoverVersions,
  stablePublicEndpointState,
  resolvePlatformPreviousTriggerConfig,
} from './platform-installer-workers.ts';

export {
  loadPlatformRuntime,
  verifyRuntimeArtifacts,
  verifyPlatformDatabaseArtifacts,
} from './platform-installer-runtime.ts';

export {
  PlatformAccessBlockedError,
  verifyPlatformHealth,
  verifyPlatformSandboxDrain,
  verifyPlatformDeploymentExecutionDrain,
  bootstrapPlatformSharedEmail,
} from './platform-installer-health.ts';
