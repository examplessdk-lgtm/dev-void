import {
  recordInstallationStep,
  transitionInstallation,
  type PlatformInstallationManifest,
  type PlatformLifecycleOperation,
} from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { join } from 'pathslash';
import { verifyPlatformAuthenticationDatabase } from './platform-auth-database.ts';
import { preparePlatformDatabaseSchema } from './platform-installer-database.ts';
import {
  requireId,
  recordResource,
  recordProvisionIntent,
  createResource,
  recordAdoptionIntent,
  hasProvisionIntent,
  reconcilePlatformInstallationResources,
  hash,
} from './platform-installer-resources.ts';
import {
  type InstallationCheckpointWriter,
  type PlatformDatabaseLifecycleLock,
  type PlatformInstallerDependencies,
  type PlatformInstallationSecrets,
  type PlatformInstallationResult,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';

export async function provisionInstallationServices(input: {
  readonly plan: PlatformInstallPlan;
  manifest: PlatformInstallationManifest;
  readonly now: () => string;
  readonly releaseDatabaseLock: PlatformDatabaseLifecycleLock;
  readonly dependencies: PlatformInstallerDependencies;
  readonly secrets: PlatformInstallationSecrets;
  readonly writeRemoteInstallationCheckpoint: InstallationCheckpointWriter;
  readonly checkpointOperation: (phase: PlatformLifecycleOperation['phase']) => Promise<void>;
  readonly externalHyperdriveOriginHash: string | undefined;
  readonly runtime: PlatformRuntimeManifest;
  readonly runtimeDirectory: string;
  readonly sourcePlatformVersion: string | null;
  readonly hadPriorWorkers: boolean;
}): Promise<
  | PlatformInstallationResult
  | {
      zone: PlatformInstallPlan['zone'];
      zoneId: string;
      targetSandboxDrainProtocol: 0 | 1 | 2 | 3;
      prepareSandboxDrain: PlatformInstallerDependencies['prepareSandboxDrain'];
      sandboxDrainState: 'complete' | 'pending';
      ids: { [k: string]: string };
      entrypoints: Record<'api' | 'dispatch' | 'proxy' | 'tail', string> &
        Partial<Record<'emailGateway', string>>;
    }
> {
  const {
    plan,
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
  } = input;

  const routingAction = plan.actions.find((action) => action.key === 'routing-kv')!;
  if (routingAction.action === 'adopt') {
    throw new Error('platform: The routing checkpoint cannot be adopted.');
  }
  if (routingAction.action === 'reuse') {
    if (
      !input.manifest.resources.some((resource) => resource.key === routingAction.key) &&
      routingAction.id
    ) {
      input.manifest = recordResource(
        input.manifest,
        routingAction,
        routingAction.id,
        'created',
        now(),
      );
      writeInstallationManifest(input.manifest);
    }
  } else {
    input.manifest = recordProvisionIntent(input.manifest, routingAction, now());
    writeInstallationManifest(input.manifest);
    await releaseDatabaseLock.checkpoint?.(input.manifest);
    const routing = await createResource(
      dependencies.client,
      plan,
      routingAction,
      secrets.databaseUrl,
      '',
    );
    input.manifest = recordResource(input.manifest, routingAction, routing.id, 'created', now());
    writeInstallationManifest(input.manifest);
  }
  await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);

  const zoneAction = plan.actions.find((action) => action.key === 'zone');
  let zone = plan.zone;
  if (zoneAction) {
    if (zoneAction.action === 'create') {
      input.manifest = recordProvisionIntent(input.manifest, zoneAction, now());
      writeInstallationManifest(input.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      zone = await dependencies.client.createZone(plan.account.id, zoneAction.name);
    }
    if (!zone) {
      throw new Error('platform: Cloudflare did not return the platform zone.');
    }
    if (zoneAction.action === 'adopt') {
      input.manifest = recordAdoptionIntent(input.manifest, zoneAction, zone.id, now());
      writeInstallationManifest(input.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
    }
    input.manifest = recordResource(
      input.manifest,
      zoneAction,
      zone.id,
      zoneAction.action === 'adopt'
        ? 'adopted'
        : zoneAction.action === 'create' || hasProvisionIntent(input.manifest, zoneAction)
          ? 'created'
          : undefined,
      now(),
    );
    writeInstallationManifest(input.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
    if (zone.status !== 'active') {
      input.manifest = transitionInstallation(input.manifest, 'waiting-for-dns', now());
      await checkpointOperation('waiting-for-dns');
      writeInstallationManifest(input.manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      return {
        manifest: input.manifest,
        waitingForDns: true,
        waitingForSandboxDrain: false,
        zoneNameServers: zone.nameServers,
      };
    }
  }
  const zoneId = zone?.id ?? '';
  input.manifest = await reconcilePlatformInstallationResources(
    input.manifest,
    plan,
    secrets,
    zoneId,
    externalHyperdriveOriginHash,
    dependencies,
    now,
    writeRemoteInstallationCheckpoint,
    (next) => {
      input.manifest = next;
    },
  );

  dependencies.onProgress?.('Verifying uncached authentication database reads');
  const authenticationDatabase = input.manifest.resources.find(
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

  input.manifest = await preparePlatformDatabaseSchema(
    input.manifest,
    runtime,
    runtimeDirectory,
    sourcePlatformVersion,
    hadPriorWorkers,
    plan,
    dependencies,
    releaseDatabaseLock,
    now,
    writeRemoteInstallationCheckpoint,
    (next) => {
      input.manifest = next;
    },
  );

  dependencies.onProgress?.('Checking platform safety');
  const targetSandboxDrainProtocol = runtime.safetyProtocols.sandboxDrain;
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
  const sandboxDrainState = sandboxDrainPreparation?.state ?? 'complete';
  if (
    targetSandboxDrainProtocol >= 1 &&
    (input.manifest.safetyProtocols?.sandboxDrain ?? 0) < targetSandboxDrainProtocol
  ) {
    input.manifest = {
      ...input.manifest,
      safetyProtocols: { sandboxDrain: targetSandboxDrainProtocol },
      updatedAt: now(),
    };
    writeInstallationManifest(input.manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
  }

  input.manifest = transitionInstallation(input.manifest, 'deploying', now());
  await checkpointOperation('deploying');
  writeInstallationManifest(input.manifest);
  const ids = Object.fromEntries(
    input.manifest.resources.map((resource) => [resource.key, resource.id]),
  );
  const bootstrapStep = 'bootstrap-access:v1';
  if (!input.manifest.steps.some((step) => step.key === bootstrapStep)) {
    const routingKv = requireId(ids, 'routing-kv');
    await dependencies.client.putKvValue(plan.account.id, routingKv, 'signup:enabled', 'true');
    await dependencies.client.putKvValue(
      plan.account.id,
      routingKv,
      'signup:allowlist',
      JSON.stringify([]),
    );
    input.manifest = recordInstallationStep(
      input.manifest,
      {
        completedAt: now(),
        key: bootstrapStep,
        resultHash: hash(secrets.authenticationSetupJson ?? secrets.bootstrapGitHubId),
      },
      now(),
    );
    writeInstallationManifest(input.manifest);
  }
  const entrypoints = Object.fromEntries(
    Object.entries(runtime.artifacts).map(([key, artifact]) => [
      key,
      join(runtimeDirectory, artifact.path),
    ]),
  ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string> &
    Partial<Record<'emailGateway', string>>;
  return {
    zone,
    zoneId,
    targetSandboxDrainProtocol,
    prepareSandboxDrain,
    sandboxDrainState,
    ids,
    entrypoints,
  };
}
