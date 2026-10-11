import {
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  transitionInstallation,
  type PlatformInstallationManifest,
  type PlatformLifecycleOperation,
} from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { platformWorkerAction, platformWorkerDeployCallbacks } from './platform-install-workers.ts';
import { verifyPlatformHealth, bootstrapPlatformSharedEmail } from './platform-installer-health.ts';
import {
  requireId,
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
} from './platform-installer-resources.ts';
import {
  secretCheckpoint,
  createPlatformHealthProbeToken,
  platformWorkerSecretPayload,
} from './platform-installer-secrets.ts';
import {
  type InstallationCheckpointWriter,
  type PlatformDatabaseLifecycleLock,
  type PlatformInstallerDependencies,
  type PlatformWorkerRollback,
  type PlatformInstallationSecrets,
  type PlatformWorkerKey,
  type PlatformWorkerSecretUpdateIntent,
  type PlatformHealthCheckContext,
} from './platform-installer-types.ts';
import {
  recordWorkerCutoverResolution,
  recordWorkerTrafficState,
  runPlatformWrangler,
  nextWorkerCutoverGeneration,
  recordWorkerSecretUpdateState,
  deployPlatformWorker,
  verifyPlatformWorkerCutoverVersions,
} from './platform-installer-workers.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import { writeInstallationManifest, writePendingInstallationSecrets } from './platform-registry.ts';
import { platformManagedWorkerTraffic } from './platform-traffic.ts';

export async function enableInstallationServices(input: {
  readonly checkpointOperation: (phase: PlatformLifecycleOperation['phase']) => Promise<void>;
  readonly requiresStagedCommit: boolean;
  readonly authenticationCutoverCommitted: boolean;
  manifest: PlatformInstallationManifest;
  workerCutoverGeneration: number;
  readonly now: () => string;
  readonly writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  readonly dependencies: PlatformInstallerDependencies;
  readonly plan: PlatformInstallPlan;
  workerRollbacks: Array<PlatformWorkerRollback>;
  workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null;
  readonly secrets: PlatformInstallationSecrets;
  readonly workerKeys: ReadonlyArray<PlatformWorkerKey>;
  readonly workerActions: ReadonlyArray<PlatformInstallPlanAction>;
  readonly workerDeploymentSecrets: PlatformInstallationSecrets;
  readonly zoneId: string;
  readonly enabledConfigs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly configs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly cloudflareApiBaseUrl: string;
  readonly managedRoutes: ReturnType<typeof platformManagedWorkerTraffic>['routes'];
  readonly ids: { [k: string]: string };
  readonly runPinnedPlatformWrangler: typeof runPlatformWrangler;
  readonly shouldBootstrapSharedEmail: boolean;
  workerDeploymentCommitted: boolean;
  readonly releaseDatabaseLock: PlatformDatabaseLifecycleLock;
  readonly wasDisabled: boolean;
  readonly previousPublicEndpoints: boolean;
  readonly version: string;
  readonly targetUsageProtocolVersion: 0 | 1 | 2;
  readonly healthCheckContext: PlatformHealthCheckContext;
  readonly runtime: PlatformRuntimeManifest;
  readonly runtimeProvenance: NonNullable<PlatformInstallationManifest['runtime']>;
}): Promise<{ emailOperationId: string | undefined }> {
  const {
    checkpointOperation,
    requiresStagedCommit,
    authenticationCutoverCommitted,
    now,
    writeRemoteInstallationCheckpoint,
    dependencies,
    plan,
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
    releaseDatabaseLock,
    wasDisabled,
    previousPublicEndpoints,
    version,
    targetUsageProtocolVersion,
    healthCheckContext,
    runtime,
    runtimeProvenance,
  } = input;

  await checkpointOperation('enabling');
  if (requiresStagedCommit) {
    if (!authenticationCutoverCommitted) {
      input.manifest = recordWorkerCutoverResolution(
        input.manifest,
        input.workerCutoverGeneration,
        'committed',
        now(),
      );
      input.manifest = recordWorkerTrafficState(
        input.manifest,
        input.workerCutoverGeneration,
        false,
        now(),
      );
      writeInstallationManifest(input.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      input.workerRollbacks = [];
    }

    input.workerCutoverGeneration = nextWorkerCutoverGeneration(input.manifest);
    if (input.workerSecretUpdateIntent) {
      input.manifest = recordWorkerSecretUpdateState(
        input.manifest,
        input.workerCutoverGeneration,
        'pending',
        input.workerSecretUpdateIntent.id,
        now(),
      );
      writeInstallationManifest(input.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      input.workerSecretUpdateIntent = {
        ...input.workerSecretUpdateIntent,
        generation: input.workerCutoverGeneration,
      };
      writePendingInstallationSecrets(
        input.manifest,
        secretCheckpoint(secrets, input.workerSecretUpdateIntent),
      );
    }
    const writeManifest = async (next: PlatformInstallationManifest): Promise<void> => {
      input.manifest = next;
      writeInstallationManifest(next);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, next);
    };
    for (const key of workerKeys) {
      dependencies.onProgress?.(`Enabling the ${key} service`);
      const action = platformWorkerAction(workerActions, key);
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
      const previousWorkerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
      const rollback = dependencies.deployWorker
        ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
        : await deployPlatformWorker(workerConfig, workerSecrets, {
            ...platformWorkerDeployCallbacks({
              client: dependencies.client,
              plan,
              zoneId,
              ids,
              key,
              action,
              generation: input.workerCutoverGeneration,
              now,
              readManifest: () => input.manifest,
              writeManifest,
              checkpoint: (update) => update(),
            }),
            apiBaseUrl: cloudflareApiBaseUrl,
            managedRoutes: managedRoutes
              .filter((route) => route.script === action.name)
              .map((route) => route.pattern),
            preservedRoutes,
            previousConfig: previousWorkerConfig,
            previousPublicEndpoints: true,
            // Traffic opens only after every Worker in this generation is
            // verified against its own staged checkpoint, so none may be reused.
            reuseMatchingVersion: false,
            runner: runPinnedPlatformWrangler,
            workerExisted: true,
          });
      if (rollback) {
        input.workerRollbacks.push(rollback);
      }
    }
  }
  const verifyCurrentWorkerCutover = async () => {
    if (!requiresStagedCommit) {
      return;
    }
    if (dependencies.verifyWorkerCutover) {
      await dependencies.verifyWorkerCutover(input.manifest, input.workerCutoverGeneration);
    } else if (!dependencies.deployWorker) {
      await verifyPlatformWorkerCutoverVersions(
        input.manifest,
        input.workerCutoverGeneration,
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
    input.workerDeploymentCommitted = true;
    input.manifest = recordWorkerCutoverResolution(
      input.manifest,
      input.workerCutoverGeneration,
      'committed',
      now(),
    );
    if (input.workerSecretUpdateIntent) {
      input.manifest = recordWorkerSecretUpdateState(
        input.manifest,
        input.workerCutoverGeneration,
        'committed',
        input.workerSecretUpdateIntent.id,
        now(),
      );
    }
    writeInstallationManifest(input.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
    input.workerRollbacks = [];
    dependencies.onProgress?.('Preparing shared email routing');
    emailOperationId = await (dependencies.bootstrapEmail ?? bootstrapPlatformSharedEmail)(
      plan.apiUrl,
      createPlatformHealthProbeToken(input.manifest.ownershipNonce),
    );
  }
  // A failed uninstall, or one whose database is reused, leaves its record
  // behind. Remove it before traffic opens so Zero Trust writers run again.
  await releaseDatabaseLock.liftProjectZeroTrustFence?.();
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
      input.manifest.id,
      plan.proxyUrl,
      plan.deployment.application.baseDomain,
      version,
      targetUsageProtocolVersion,
      createPlatformHealthProbeToken(input.manifest.ownershipNonce),
      undefined,
      !plan.deployment.application.zoneName
        ? `https://${plan.deployment.resources.dispatchWorker}.${plan.workersSubdomain}.workers.dev`
        : undefined,
      healthCheckContext,
    );
    await verifyCurrentWorkerCutover();
  }
  input.workerDeploymentCommitted = true;
  input.manifest = recordWorkerCutoverResolution(
    input.manifest,
    input.workerCutoverGeneration,
    'committed',
    now(),
  );
  input.manifest = recordWorkerTrafficState(
    input.manifest,
    input.workerCutoverGeneration,
    true,
    now(),
  );
  if (input.workerSecretUpdateIntent) {
    input.manifest = recordWorkerSecretUpdateState(
      input.manifest,
      input.workerCutoverGeneration,
      'committed',
      input.workerSecretUpdateIntent.id,
      now(),
    );
  }
  input.manifest = {
    ...input.manifest,
    deployment: plan.deployment,
    deploymentExecution: runtime.deploymentExecution,
    platformVersion: version,
    runtime: runtimeProvenance,
    safetyProtocols: runtime.safetyProtocols,
    updatedAt: now(),
    usageProtocolVersion: targetUsageProtocolVersion,
  };
  input.manifest = transitionInstallation(input.manifest, 'installed', now());
  return { emailOperationId };
}
