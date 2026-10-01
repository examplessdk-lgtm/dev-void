import { createHash } from 'node:crypto';
import { confirm, isCancel, log, note, outro, select } from '@clack/prompts';
import {
  createPlatformResourceOwnershipMarker,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import { createSpinner } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import { platformDatabaseNameFromOwnerUrl } from './platform-auth-database.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  resolvePlatformCloudflareCredential,
} from './platform-auth.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  hyperdriveOriginMatches,
  PlatformCloudflareClient,
  verifyPlatformRuntimeTokenPermissions,
} from './platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformInstallationSecrets,
  installPlatform,
  loadPlatformRuntime,
  readPlatformProjectZeroTrustState,
  REMOTE_INSTALLATION_MANIFEST_KEY,
  resolveBootstrapGitHubId,
  type PlatformDatabaseLifecycleLock,
} from './platform-installer.ts';
import { resolvePlatformInstallDatabaseUrl } from './platform-lifecycle.ts';
import { assertNoninteractivePlatformMutationAcknowledged } from './platform-lifecycle.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
  revalidatePlatformInstallAction,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  listInstallationManifests,
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  removePlatformConnectionForInstallation,
  resolveInstallationManifest,
  writeInstallationManifest,
} from './platform-registry.ts';
import { trackedPlatformWorkerTraffic } from './platform-traffic.ts';
import {
  assertProjectZeroTrustAllowsUninstall,
  type PlatformProjectZeroTrustState,
} from './platform-zero-trust-uninstall.ts';

export type PlatformManagementClient = Pick<
  PlatformCloudflareClient,
  | 'deleteKvValue'
  | 'deleteResource'
  | 'findZone'
  | 'getHyperdriveConfig'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'putKvValue'
  | 'removeRoutes'
>;

export type PlatformUninstallClient = PlatformManagementClient &
  Pick<PlatformCloudflareClient, 'listWorkerDomains' | 'listWorkerServiceRoutes'>;

export type PlatformOwnershipClient = Pick<
  PlatformManagementClient,
  | 'findZone'
  | 'getHyperdriveConfig'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
>;

export async function verifyPlatformInstallationOwnership(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  options: {
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
    databaseUrl?: string;
    retainedReplacementKeys?: ReadonlySet<string>;
  } = {},
): Promise<void> {
  const ready = manifest.resources.filter(
    (resource) =>
      resource.state === 'ready' &&
      isOwnershipVerifiableKind(resource.kind) &&
      !options.retainedReplacementKeys?.has(resource.key),
  );
  const routing = ready.find((resource) => resource.key === 'routing-kv');
  if (!routing) {
    const unsafe = ready.filter((resource) => resource.kind !== 'zone');
    if (unsafe.length > 0) {
      throw ownershipError(
        `the remote installation checkpoint is missing for ${unsafe[0]!.kind} ${unsafe[0]!.name}`,
      );
    }
    const zone = ready.find((resource) => resource.kind === 'zone');
    if (zone) {
      const current = await client.findZone(manifest.account.id, zone.name);
      if (current?.id !== zone.id) {
        throw ownershipError(`zone ${zone.name} was replaced`);
      }
    }
    return;
  }
  await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set(ready.map((resource) => resource.key)),
    options,
  );
}

export type PlatformManagementDependencies = Readonly<{
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  confirm?: (message: string, initialValue: boolean) => Promise<boolean>;
  databaseUrl?: string;
  interactive?: boolean;
  /** Uninstall refuses to start when this is missing or cannot read the state. */
  readProjectZeroTrust?: () => Promise<PlatformProjectZeroTrustState>;
  /** Holds off Zero Trust writers from the final check until traffic is disabled. */
  lockProjectZeroTrust?: () => Promise<() => Promise<void>>;
  /** Makes Zero Trust writers that later get the lock refuse; called while it is held. */
  fenceProjectZeroTrust?: () => Promise<void>;
  /** Removes that fence when uninstall stops before it disables traffic. */
  liftProjectZeroTrustFence?: () => Promise<void>;
}>;

export function selectAuthoritativePlatformManifest(
  local: PlatformInstallationManifest,
  authoritative: PlatformInstallationManifest | null | undefined,
): PlatformInstallationManifest {
  if (!authoritative) {
    return local;
  }
  if (
    authoritative.id !== local.id ||
    authoritative.ownershipNonce !== local.ownershipNonce ||
    authoritative.account.id !== local.account.id
  ) {
    throw new Error('platform: The authoritative lifecycle state belongs to another installation.');
  }
  return authoritative;
}

export async function runInstalledPlatformCommand(args: PlatformArgs): Promise<void> {
  if (
    args.subcommand !== 'upgrade' &&
    args.subcommand !== 'rollback' &&
    args.subcommand !== 'repair' &&
    args.subcommand !== 'disable' &&
    args.subcommand !== 'enable' &&
    args.subcommand !== 'uninstall'
  ) {
    throw new Error(`platform: Unsupported lifecycle command ${args.subcommand}.`);
  }
  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);
  const timingStart = performance.now();
  let timingPrevious = timingStart;
  const markPhase = (phase: string) => {
    if (process.env.VOID_PLATFORM_TIMINGS !== '1') {
      return;
    }
    const current = performance.now();
    process.stderr.write(
      `[platform timing] phase ${phase} ${(current - timingPrevious).toFixed(0)} ms, total ${(current - timingStart).toFixed(0)} ms\n`,
    );
    timingPrevious = current;
  };
  const manifest = await resolveInstalledPlatformManifest(args.selector);
  const operatorCredential = await resolvePlatformCloudflareCredential();
  const operatorClient = new PlatformCloudflareClient(operatorCredential.token);
  const runtime =
    args.subcommand === 'uninstall' || args.subcommand === 'disable'
      ? null
      : loadPlatformRuntime(args.runtime);
  const rollbackSourceRuntime =
    args.subcommand === 'rollback' ? loadPlatformRuntime(args.fromRuntime) : null;
  let progress: ReturnType<typeof createSpinner> | undefined;
  let reportResult: (() => void) | undefined;

  const execute = async (
    currentManifest: PlatformInstallationManifest,
    databaseLock?: PlatformDatabaseLifecycleLock,
    databaseCheckpointExists = false,
  ): Promise<void> => {
    const manifest = currentManifest;
    if (args.subcommand === 'rollback') {
      assertPlatformRollbackCompatibility(manifest, runtime!, rollbackSourceRuntime!);
    }
    const recovery = readInstallationRecoverySecrets(manifest);
    const gatewayToken =
      process.env.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN || recovery?.cloudflareApiToken;
    const client =
      operatorCredential.source === 'oauth' && gatewayToken
        ? operatorClient.withAiGatewayToken(gatewayToken)
        : operatorClient;
    const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, manifest);

    if (args.subcommand === 'disable') {
      await disablePlatform(client, manifest, args.plan, {
        checkpoint: databaseLock?.checkpoint,
        databaseUrl,
      });
      return;
    }
    if (args.subcommand === 'uninstall') {
      await uninstallPlatform(client, manifest, args, {
        checkpoint: databaseLock?.checkpoint,
        databaseUrl,
        // A plan holds no lifecycle lock, so it opens its own read-only connection.
        readProjectZeroTrust: databaseLock
          ? databaseLock.readProjectZeroTrust
          : () =>
              readPlatformProjectZeroTrustState(databaseUrl, manifest.id, manifest.ownershipNonce),
        lockProjectZeroTrust: databaseLock?.lockProjectZeroTrust,
        fenceProjectZeroTrust: databaseLock?.fenceProjectZeroTrust,
        liftProjectZeroTrustFence: databaseLock?.liftProjectZeroTrustFence,
      });
      return;
    }
    if (
      args.subcommand === 'enable' &&
      manifest.desiredState === 'enabled' &&
      manifest.status === 'installed'
    ) {
      log.info(`${manifest.deployment.displayName} is already enabled.`);
      return;
    }

    const deployment = manifest.deployment;
    const planInput = {
      accountId: manifest.account.id,
      ...(args.subcommand === 'upgrade' && process.env.VOID_EMAIL_SHARED_ZONE_ID
        ? { emailSharedZoneId: process.env.VOID_EMAIL_SHARED_ZONE_ID }
        : {}),
      ...(args.subcommand === 'upgrade' && process.env.VOID_EMAIL_SENDER_DOMAIN
        ? { emailSenderDomain: process.env.VOID_EMAIL_SENDER_DOMAIN }
        : {}),
      applicationDomain: deployment.application.baseDomain,
      controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
      ...(args.subcommand !== 'rollback' && args.dashboardUrl !== undefined
        ? { dashboardUrl: args.dashboardUrl }
        : {}),
      dedicatedZone: deployment.application.dedicatedZone,
      displayName: deployment.displayName,
      installationSlug: deployment.installationSlug,
      zoneName: deployment.application.zoneName,
    };
    const plan = await createPlatformInstallPlan(client, planInput, manifest, {
      authoritativeProvisionIntents: databaseCheckpointExists,
      repairMissing: args.subcommand === 'repair',
      allowUnverifiedAiGateway: args.plan,
      includeEmailGateway: runtime!.manifest.artifacts.emailGateway !== undefined,
      enableSandbox: runtime!.manifest.safetyProtocols.sandboxDrain >= 3,
      deploymentExecution: runtime!.manifest.deploymentExecution === 1,
    });
    markPhase('plan');
    note(
      formatPlatformInstallPlan(plan),
      args.subcommand === 'upgrade'
        ? 'Upgrade plan'
        : args.subcommand === 'rollback'
          ? 'Rollback plan'
          : args.subcommand === 'enable'
            ? 'Enable plan'
            : 'Repair plan',
    );
    note(
      [
        `Version: ${runtime!.manifest.platformVersion}`,
        `Source: ${runtime!.source}`,
        `Revision: ${runtime!.manifest.sourceRevision ?? 'not recorded'}`,
        `Manifest SHA-256: ${runtime!.manifestSha256}`,
      ].join('\n'),
      'Platform runtime',
    );
    if (args.plan) {
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    assertPlatformOperatorCredentialCanApplyPlan(operatorCredential, plan);
    progress = createSpinner({
      // Preserve the subprocess signal coordinator used by platform installs.
      onCancel: () => {
        if (!process.emit('SIGINT')) {
          process.exit(130);
        }
      },
    });
    progress.start(
      args.subcommand === 'upgrade'
        ? 'Upgrading the platform'
        : args.subcommand === 'rollback'
          ? 'Rolling back the platform'
          : args.subcommand === 'enable'
            ? 'Enabling the platform'
            : 'Repairing the platform',
    );
    const repairingMissingRoutingCheckpoint =
      args.subcommand === 'repair' &&
      plan.actions.some(
        (action) => action.key === 'routing-kv' && action.action === 'create' && action.id === null,
      );
    await verifyPlatformMutationOwnership(
      client,
      manifest,
      new Set(
        manifest.resources
          .filter(
            (resource) =>
              isOwnershipVerifiableKind(resource.kind) &&
              !plan.actions.some(
                (action) =>
                  action.key === resource.key &&
                  action.action === 'create' &&
                  action.name !== resource.name,
              ),
          )
          .map((resource) => resource.key),
      ),
      {
        allowMissingRoutingCheckpoint: repairingMissingRoutingCheckpoint,
        allowUninitializedRoutingCheckpoint:
          args.subcommand === 'repair' && databaseCheckpointExists,
        databaseUrl,
      },
    );
    markPhase('ownership');
    const installation =
      args.subcommand === 'enable'
        ? setInstallationDesiredState(manifest, 'enabled', new Date().toISOString())
        : manifest;
    if (installation !== manifest) {
      writeInstallationManifest(installation);
    }
    const bootstrapGitHubLogin =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_LOGIN || recovery?.bootstrapGitHubLogin || '';
    const bootstrapGitHubId =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
      recovery?.bootstrapGitHubId ||
      (bootstrapGitHubLogin ? await resolveBootstrapGitHubId(bootstrapGitHubLogin) : '');
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId,
      bootstrapGitHubLogin,
      cloudflareApiToken: process.env.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN || '',
      checkpoint: recovery,
      databaseUrl,
      emailEnabled: plan.deployment.capabilities.email,
      emailSigningSecret: process.env.VOID_PLATFORM_EMAIL_SIGNING_SECRET || '',
      existingEmailEnabled: manifest.deployment.capabilities.email,
      existingInstallation: true,
      updateExistingWorkers: true,
      githubClientId: process.env.VOID_PLATFORM_GITHUB_CLIENT_ID || '',
      githubClientSecret: process.env.VOID_PLATFORM_GITHUB_CLIENT_SECRET || '',
      jwtSecret: process.env.VOID_PLATFORM_JWT_SECRET || '',
      projectSecretKey: process.env.VOID_PLATFORM_PROJECT_SECRET_KEY || '',
      projectSecretKeysJson: process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON || '',
      projectSecretActiveKeyVersion:
        process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION || '',
      r2AccessKeyId: process.env.VOID_PLATFORM_R2_ACCESS_KEY_ID || '',
      r2SecretAccessKey: process.env.VOID_PLATFORM_R2_SECRET_ACCESS_KEY || '',
    });
    const runtimeTokenToPreflight = resolvePlatformRuntimeTokenToPreflight(plan, secrets);
    if (runtimeTokenToPreflight) {
      await verifyPlatformRuntimeTokenPermissions(
        new PlatformCloudflareClient(runtimeTokenToPreflight),
        {
          accountId: manifest.account.id,
          applicationDomain: deployment.application.baseDomain,
          customDomains: plan.deployment.capabilities.customDomains,
          zoneId: plan.zone?.id ?? null,
        },
      );
    }
    markPhase('runtime token');
    if (!databaseLock?.readAuthenticationState) {
      throw new Error(
        'platform: The database lifecycle lock cannot read authoritative authentication settings.',
      );
    }
    const result = await installPlatform(plan, secrets, installation, {
      // runInstalledPlatformCommand holds the database session lock across the
      // entire replan and mutation sequence.
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          checkpoint: databaseLock?.checkpoint,
          liftProjectZeroTrustFence: databaseLock?.liftProjectZeroTrustFence,
          prepareDatabase: databaseLock?.prepareDatabase,
          prepareSandboxDrain: databaseLock?.prepareSandboxDrain,
          readAuthenticationState: databaseLock?.readAuthenticationState,
          requiredSafetyProtocols: databaseLock?.requiredSafetyProtocols,
          verifyDatabase: databaseLock?.verifyDatabase,
        }),
      client,
      databaseRollbackSource: rollbackSourceRuntime ?? undefined,
      onProgress: (message) => {
        markPhase(message);
        progress?.message(message);
      },
      runtime: runtime!,
      replanWorkers: async (recoveryManifest) =>
        (
          await createPlatformInstallPlan(client, planInput, recoveryManifest, {
            authoritativeProvisionIntents: true,
            repairMissing: true,
            includeEmailGateway: runtime!.manifest.artifacts.emailGateway !== undefined,
            enableSandbox: runtime!.manifest.safetyProtocols.sandboxDrain >= 3,
            deploymentExecution: runtime!.manifest.deploymentExecution === 1,
          })
        ).actions.filter((action) => action.kind === 'worker'),
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action, {
          repairMissing: args.subcommand === 'repair',
          stableWorkerUpdate: args.subcommand === 'upgrade',
        }),
    });
    // Keep progress visible while the outer database session releases its lock.
    progress.message('Finalizing platform changes');
    markPhase('installer complete');
    reportResult = () => {
      progress?.stop(
        result.waitingForDns || result.waitingForSandboxDrain
          ? 'Platform operation paused; progress is saved.'
          : `Platform ${args.subcommand} complete.`,
      );
      progress = undefined;
      if (result.waitingForDns) {
        note(
          `Wait for ${deployment.application.zoneName} to become active, then rerun this command.`,
          'Waiting for nameservers',
        );
        return;
      }
      if (result.waitingForSandboxDrain) {
        note(
          "The compatible candidate runtime is live in sandbox-drain maintenance mode and application traffic remains disabled. Preview bounded work with `void platform system sandbox-drain --plan`; follow any returned `nextCursor` with `--cursor '<value>'`. Then apply with `void platform system sandbox-drain --yes` and rerun until it reports DB-backed `complete: true`. Rerun this lifecycle command afterward to enable traffic.",
          'Waiting for managed Sandbox drain',
        );
        return;
      }
      log.success(
        args.subcommand === 'rollback'
          ? `${deployment.displayName} is running compatible runtime ${runtime!.manifest.platformVersion}; PostgreSQL remains at schema ${rollbackSourceRuntime!.manifest.database.schemaDigest}.`
          : `${deployment.displayName} is healthy at ${plan.apiUrl}.`,
      );
      if (result.emailOperationId) {
        log.info(`Shared email routing ready (operation ${result.emailOperationId}).`);
      }
      if (result.setupPending) {
        const code = readInstallationRecoverySecrets(result.manifest)?.authBootstrapCode;
        if (code) {
          log.info(`First administrator setup: ${plan.apiUrl}/setup`);
          console.log(`One-time administrator setup code: ${code}`);
        }
      }
    };
  };

  if (args.plan) {
    await execute(manifest);
    return;
  }
  const release = acquirePlatformLifecycleLock(
    manifest.account.id,
    manifest.deployment.installationSlug,
  );
  try {
    const current = resolveInstallationManifest(manifest.id);
    const recovery = readInstallationRecoverySecrets(current);
    const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, current);
    if (!databaseUrl) {
      throw new Error(
        'platform: DATABASE_URL is required to safely serialize lifecycle changes across hosts.',
      );
    }
    const releaseDatabase = await acquirePlatformDatabaseLifecycleLock(
      databaseUrl,
      current.id,
      current.ownershipNonce,
    );
    markPhase('database lock');
    try {
      const authoritative = releaseDatabase.authoritativeManifest;
      const databaseCheckpointExists = authoritative !== null && authoritative !== undefined;
      const currentManifest = selectAuthoritativePlatformManifest(current, authoritative);
      if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(current)) {
        writeInstallationManifest(authoritative);
      }
      if (!authoritative) {
        await releaseDatabase.checkpoint?.(currentManifest);
      }
      await execute(currentManifest, releaseDatabase, databaseCheckpointExists);
    } finally {
      await releaseDatabase();
    }
    reportResult?.();
    markPhase('complete');
  } catch (error) {
    progress?.error(`Platform ${args.subcommand} failed.`);
    progress = undefined;
    throw error;
  } finally {
    try {
      progress?.clear();
    } finally {
      release();
    }
  }
}

export function assertPlatformRollbackCompatibility(
  installation: PlatformInstallationManifest,
  target: ReturnType<typeof loadPlatformRuntime>,
  source: ReturnType<typeof loadPlatformRuntime>,
): void {
  if (
    target.manifest.emailProtocolVersion !== 1 &&
    (installation.deployment.capabilities.email ||
      installation.resources.some(
        (resource) => resource.key === 'email-gateway-worker' && resource.state === 'ready',
      ))
  ) {
    throw new Error(
      'platform: The rollback target predates the email gateway and cannot safely replace this installation. Use a runtime with email protocol version 1.',
    );
  }
  if (!installation.runtime) {
    throw new Error(
      'platform: The installed runtime has no artifact provenance, so post-success rollback cannot identify its compatibility manifest.',
    );
  }
  if (
    source.manifest.platformVersion !== installation.platformVersion ||
    source.manifestSha256 !== installation.runtime.manifestSha256
  ) {
    throw new Error(
      'platform: --from-runtime does not exactly match the installed runtime artifact digest. Supply the runtime used by the current successful deployment.',
    );
  }
  if (target.manifestSha256 === source.manifestSha256) {
    throw new Error('platform: The rollback target is already the installed runtime artifact.');
  }
  if (
    (target.manifest.authenticationProtocolVersion ?? 0) <
    Math.max(
      source.manifest.authenticationProtocolVersion ?? 0,
      installation.deployment.authentication.configurable ? 1 : 0,
    )
  ) {
    throw new Error(
      'platform: The rollback target cannot enforce the installed authentication configuration and session revocation protocol. Use a compatible runtime.',
    );
  }
  if (
    Math.max(installation.usageProtocolVersion, source.manifest.usageProtocolVersion) >= 2 &&
    target.manifest.usageProtocolVersion < 2
  ) {
    throw new Error(
      'platform: The rollback target predates ownership-aware usage attribution and cannot safely account for transferred projects. Use a runtime with usage protocol version 2 or newer.',
    );
  }
  if (target.manifest.database.lineage !== source.manifest.database.lineage) {
    throw new Error('platform: The rollback target belongs to a different database lineage.');
  }
  const prefix = source.manifest.database.migrations.slice(
    0,
    target.manifest.database.migrations.length,
  );
  if (JSON.stringify(prefix) !== JSON.stringify(target.manifest.database.migrations)) {
    throw new Error(
      'platform: The rollback target database migrations are not an exact prefix of the installed runtime.',
    );
  }
  const compatible = source.manifest.database.rollbackSafeFrom.some(
    (entry) =>
      entry.platformVersion === target.manifest.platformVersion &&
      entry.schemaDigest === target.manifest.database.schemaDigest,
  );
  if (!compatible) {
    throw new Error(
      `platform: Installed runtime ${source.manifest.platformVersion} does not declare post-success rollback compatibility with ${target.manifest.platformVersion} at schema ${target.manifest.database.schemaDigest}.`,
    );
  }
  if (installation.databaseSchemaDigest !== source.manifest.database.schemaDigest) {
    throw new Error(
      'platform: The authoritative installation checkpoint does not record the installed runtime database schema. Repair or roll forward before rollback.',
    );
  }
  if (
    (target.manifest.safetyProtocols?.sandboxDrain ?? 0) <
    (installation.safetyProtocols?.sandboxDrain ?? 0)
  ) {
    throw new Error(
      'platform: The rollback target predates the installed sandbox-drain safety protocol.',
    );
  }
}

export function resolvePlatformRuntimeTokenToPreflight(
  plan: {
    actions: ReadonlyArray<{ action: string; key: string; kind: string }>;
  },
  secrets: Pick<
    ReturnType<typeof createPlatformInstallationSecrets>,
    'cloudflareApiToken' | 'workerSecretUpdates'
  >,
): string {
  const explicitUpdate = secrets.workerSecretUpdates?.CF_API_TOKEN;
  if (explicitUpdate) {
    return explicitUpdate;
  }
  return plan.actions.some(
    (action) =>
      action.kind === 'worker' &&
      action.action === 'create' &&
      (action.key === 'api-worker' || action.key === 'proxy-worker'),
  )
    ? secrets.cloudflareApiToken
    : '';
}

export async function resolveInstalledPlatformManifest(
  selector: string,
  dependencies: {
    interactive?: boolean;
    selectInstallation?: (
      manifests: ReadonlyArray<PlatformInstallationManifest>,
    ) => Promise<string>;
  } = {},
): Promise<PlatformInstallationManifest> {
  if (selector) {
    return resolveInstallationManifest(selector);
  }
  const manifests = listInstallationManifests().filter(
    (manifest) => manifest.status !== 'uninstalled',
  );
  if (manifests.length <= 1) {
    return resolveInstallationManifest('');
  }
  if (!(dependencies.interactive ?? process.stdin.isTTY)) {
    throw new Error('platform: Multiple local installations exist; specify an installation id.');
  }
  const picked = dependencies.selectInstallation
    ? await dependencies.selectInstallation(manifests)
    : await select({
        message: 'Select an installed Void platform:',
        options: manifests.map((manifest) => ({
          hint: `${manifest.account.name} · ${manifest.id}`,
          label: manifest.deployment.displayName,
          value: manifest.id,
        })),
      });
  if (isCancel(picked)) {
    throw new Error('platform: Cancelled.');
  }
  return resolveInstallationManifest(String(picked));
}

export async function disablePlatform(
  client: PlatformManagementClient,
  initialManifest: PlatformInstallationManifest,
  planOnly: boolean,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const reconciled = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const writeLifecycleCheckpoint = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeLifecycleCheckpointWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const writeRemoteManifestIfPresent = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteManifestIfPresentWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  note(
    'Block platform traffic through installation-owned routing storage. Retain routes and custom domains for explicit dashboard cleanup because Cloudflare cannot condition their deletion on an immutable generation. Workers and all data remain installed.',
    'Disable plan',
  );
  if (planOnly) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  const manifest = reconciled;
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
  }
  const alreadyDisabled = manifest.status === 'disabled';
  const missing = await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set([
      'routing-kv',
      'zone',
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.key),
    ]),
    { databaseUrl: dependencies.databaseUrl },
  );
  let next = setInstallationDesiredState(manifest, 'disabled', new Date().toISOString());
  writeInstallationManifest(next);
  if (!alreadyDisabled) {
    next = transitionInstallation(next, 'disabling', new Date().toISOString());
    writeInstallationManifest(next);
  }
  try {
    await writeRemoteManifestIfPresent(client, next);
    const zone = next.resources.find((resource) => resource.key === 'zone');
    const routing = requireResource(next, 'routing-kv');
    const trafficGeneration = currentTrafficGeneration(next);
    await client.putKvValue(
      next.account.id,
      routing.id,
      PLATFORM_DISABLED_KEY,
      PLATFORM_DISABLED_VALUE,
    );
    const trackedTraffic = trackedPlatformWorkerTraffic(next);
    await client.removeRoutes(
      next.account.id,
      !zone || missing.has(zone.key) ? null : zone.id,
      trackedTraffic,
    );
    next = markTrafficAttachmentsRetained(next);
    if (!hasLifecycleStep(next, `disable:${trafficGeneration}:routes`)) {
      next = recordLifecycleStep(next, `disable:${trafficGeneration}:routes`);
    }
    await writeLifecycleCheckpoint(client, next);
    next = transitionInstallation(next, 'disabled', new Date().toISOString());
    await writeLifecycleCheckpoint(client, next);
    log.success(`${next.deployment.displayName} is disabled. Its data was not changed.`);
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    await writeRemoteManifestIfPresent(client, next).catch(() => {});
    throw error;
  }
}

export async function uninstallPlatform(
  client: PlatformUninstallClient,
  initialManifest: PlatformInstallationManifest,
  args: Extract<PlatformArgs, { subcommand: 'uninstall' }>,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const reconciled = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const manifest = reconciled;
  const writeLifecycleCheckpoint = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeLifecycleCheckpointWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const writeRemoteManifestIfPresent = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteManifestIfPresentWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const retainData = !args.purgeData;
  const hasRoutingCheckpoint = manifest.resources.some(
    (resource) => resource.key === 'routing-kv' && resource.state === 'ready',
  );
  const createdZone = manifest.resources.find(
    (resource) => resource.key === 'zone' && resource.ownership === 'created',
  );
  const interactive = dependencies.interactive ?? process.stdin.isTTY;
  const confirmAction = dependencies.confirm ?? promptForConfirmation;
  if (createdZone && args.deleteZone === true) {
    throw new Error(
      `platform: Refusing to delete Cloudflare zone ${JSON.stringify(createdZone.name)} automatically. A zone can contain unrelated DNS, settings, and products that the installer cannot exhaustively prove ownership of. Uninstall with --keep-zone, inspect the retained zone in Cloudflare, and delete it manually if appropriate.`,
    );
  }
  await assertProjectZeroTrustAllowsUninstall(dependencies.readProjectZeroTrust);
  const dataMessage = retainData
    ? 'Retain installer-owned Workers, storage, dispatch, AI logs, and Hyperdrive by default.'
    : args.purgeData
      ? 'Delete safely identifiable installer-owned data (--purge-data); retain Workers, R2, AI Gateway, and external PostgreSQL for manual cleanup.'
      : 'Retain installer-owned data; external PostgreSQL is never deleted.';
  note(
    `Disable all platform traffic through installation-owned routing storage.\nRetain DNS records, routes, and custom domains for explicit dashboard cleanup.\nDelete installer-owned Queues unless a retained Worker still uses them.\n${dataMessage}\n${
      createdZone
        ? `Keep zone ${createdZone.name} for explicit manual cleanup.`
        : 'Never delete the adopted application zone.'
    }${(manifest.authenticationResources ?? []).length ? '\nRetain Access resources for deliberate cleanup:\n' + manifest.authenticationResources!.map((resource) => `  ${resource.ownership} ${resource.kind}: ${resource.name} (${resource.id}, account ${resource.accountId})`).join('\n') : ''}`,
    'Uninstall plan',
  );
  if (args.plan) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
  }
  if (!interactive && !args.yes) {
    throw new Error(
      'platform: Non-interactive `void platform uninstall` requires --yes to acknowledge Cloudflare changes. Run with --plan first to inspect them.',
    );
  }
  if (interactive && !args.yes) {
    const proceed = await confirmAction(
      args.purgeData
        ? 'Permanently purge installer-owned platform data?'
        : 'Uninstall this platform?',
      false,
    );
    if (!proceed) {
      outro('No changes made.');
      return;
    }
  }

  const resourcesToDelete = new Set(
    manifest.resources
      .filter(
        (resource) =>
          shouldDeleteResource(resource, retainData) &&
          (hasRoutingCheckpoint || resource.kind === 'zone') &&
          !(
            resource.kind === 'dns-record' &&
            !manifest.resources.some((entry) => entry.key === 'zone')
          ),
      )
      .map((resource) => resource.key),
  );
  const ownershipTargets = new Set([
    ...(hasRoutingCheckpoint ? ['routing-kv'] : []),
    'zone',
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.key),
    ...resourcesToDelete,
  ]);
  let missingResources: ReadonlySet<string>;
  if (hasRoutingCheckpoint) {
    missingResources = await verifyPlatformMutationOwnership(client, manifest, ownershipTargets, {
      allowDeletedRoutingCheckpoint: args.purgeData,
      databaseUrl: dependencies.databaseUrl,
    });
  } else {
    await verifyPlatformInstallationOwnership(client, manifest, {
      databaseUrl: dependencies.databaseUrl,
    });
    missingResources = new Set();
  }

  // Zero Trust writers in the API take this lock and never the lifecycle lock.
  // Holding it from the final check until traffic is disabled keeps them from
  // creating Access applications the check did not see. A request admitted
  // before the disable may already be waiting on the lock, so the fence makes
  // every later holder refuse. Only enabling the platform again lifts it once
  // the disable write has started.
  const { fenceProjectZeroTrust, liftProjectZeroTrustFence, lockProjectZeroTrust } = dependencies;
  if (!lockProjectZeroTrust || !fenceProjectZeroTrust || !liftProjectZeroTrustFence) {
    throw new Error(
      'platform: Refusing to uninstall because no platform database connection is available to hold off project Zero Trust changes.',
    );
  }
  const releaseProjectZeroTrust = await lockProjectZeroTrust();
  let fenced = false;
  let disablingTraffic = false;
  const stopProjectZeroTrustHold = async () => {
    if (fenced && !disablingTraffic) {
      await liftProjectZeroTrustFence().catch((error: unknown) => {
        log.warn(
          `Could not reopen project Zero Trust changes after the uninstall stopped: ${error instanceof Error ? error.message : String(error)}\nRun \`void platform uninstall\` again, or \`void platform repair\` to keep the platform.`,
        );
      });
    }
    await releaseProjectZeroTrust();
  };
  let next = manifest;
  try {
    await assertProjectZeroTrustAllowsUninstall(dependencies.readProjectZeroTrust);
    fenced = true;
    await fenceProjectZeroTrust();
    next = transitionInstallation(manifest, 'uninstalling', new Date().toISOString());
    writeInstallationManifest(next);
  } catch (error) {
    await stopProjectZeroTrustHold();
    throw error;
  }
  try {
    await writeRemoteManifestIfPresent(client, next);
    const routing = next.resources.find(
      (resource) => resource.key === 'routing-kv' && resource.state === 'ready',
    );
    disablingTraffic = true;
    if (routing) {
      await client.putKvValue(
        next.account.id,
        routing.id,
        PLATFORM_DISABLED_KEY,
        PLATFORM_DISABLED_VALUE,
      );
    }
    await releaseProjectZeroTrust();
    for (const key of missingResources) {
      const resource = requireResource(next, key);
      next = updateResourceState(
        next,
        key,
        resource.ownership === 'created' ? 'deleted' : 'retained',
      );
      await writeLifecycleCheckpoint(client, next);
    }
    const workers = new Set(
      next.resources
        .filter((resource) => resource.kind === 'worker' && resource.state === 'ready')
        .map((resource) => resource.name),
    );
    const zone = next.resources.find((resource) => resource.key === 'zone');
    if (zone?.state === 'ready') {
      for (const worker of next.resources.filter(
        (resource) =>
          resource.kind === 'worker' && resource.state === 'ready' && workers.has(resource.name),
      )) {
        const missing = await verifyPlatformMutationOwnership(
          client,
          next,
          new Set(['routing-kv', 'zone', worker.key]),
          { databaseUrl: dependencies.databaseUrl },
        );
        if (!missing.has(worker.key)) {
          const trackedTraffic = trackedPlatformWorkerTraffic(next, new Set([worker.name]));
          await client.removeRoutes(next.account.id, zone.id, trackedTraffic);
          next = markTrafficAttachmentsRetained(next);
          next = recordLifecycleStep(next, `uninstall:routes:${worker.key}`);
          await writeLifecycleCheckpoint(client, next);
        }
      }
    }
    const deletionPriority: Record<string, number> = {
      worker: 0,
      queue: 1,
      'ai-gateway': 2,
      'dns-record': 3,
      'dispatch-namespace': 4,
      hyperdrive: 5,
      'kv-namespace': 6,
      'r2-bucket': 7,
      zone: 8,
    };
    const resources = [...next.resources].sort(
      (left, right) =>
        resourceDeletionPriority(left, deletionPriority) -
        resourceDeletionPriority(right, deletionPriority),
    );
    // Uninstall retains Workers, and Cloudflare refuses to delete a Queue that
    // a Worker still binds. Delete Queues only once none of this installation's
    // Workers exist, so a retained Worker keeps its bindings intact.
    const queuesInUse =
      hasRoutingCheckpoint &&
      resources.some(
        (resource) => resource.kind === 'queue' && shouldDeleteResource(resource, retainData),
      ) &&
      (await hasLiveInstallationWorker(client, next));
    for (const resource of resources) {
      if (resource.state !== 'ready') {
        continue;
      }
      if (!hasRoutingCheckpoint && resource.kind !== 'zone') {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      if (!shouldDeleteResource(resource, retainData)) {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      if ((resource.kind === 'dns-record' && !zone) || (resource.kind === 'queue' && queuesInUse)) {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      const immediatelyMissing = await verifyPlatformMutationOwnership(
        client,
        next,
        new Set(['routing-kv', resource.key]),
        {
          allowDeletedRoutingCheckpoint: args.purgeData,
          databaseUrl: dependencies.databaseUrl,
        },
      );
      if (immediatelyMissing.has(resource.key)) {
        next = updateResourceState(
          next,
          resource.key,
          resource.ownership === 'created' ? 'deleted' : 'retained',
        );
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      await client.deleteResource(next.account.id, resource.kind, resource.id, zone?.id);
      next = updateResourceState(next, resource.key, 'deleted');
      await writeLifecycleCheckpoint(client, next);
    }
    const completed = transitionInstallation(next, 'uninstalled', new Date().toISOString());
    await writeRemoteManifestIfPresent(client, completed);
    next = completed;
    writeInstallationManifest(completed);
    if (!retainData) {
      removeInstallationRecoverySecrets(next);
    }
    removePlatformConnectionForInstallation(next.id);
    log.success(
      retainData
        ? `${next.deployment.displayName} was uninstalled; data resources were retained and recorded in ${next.id}.`
        : `${next.deployment.displayName} was uninstalled.`,
    );
  } catch (error) {
    await stopProjectZeroTrustHold().catch(() => {});
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    await writeRemoteManifestIfPresent(client, next).catch(() => {});
    throw error;
  }
}

export async function recoverDurablyMarkedProvisionIntents(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest> {
  const candidates = [
    ['api-worker', 'worker', manifest.deployment.resources.apiWorker],
    ['proxy-worker', 'worker', manifest.deployment.resources.proxyWorker],
    ['email-gateway-worker', 'worker', manifest.deployment.resources.emailGatewayWorker],
    ['tail-worker', 'worker', manifest.deployment.resources.tailWorker],
    ['dispatch-worker', 'worker', manifest.deployment.resources.dispatchWorker],
    ['assets-bucket', 'r2-bucket', manifest.deployment.resources.assetsBucket],
  ] as const;
  const pending = candidates.filter(
    ([key, kind, name]) =>
      !manifest.resources.some((resource) => resource.key === key) &&
      manifest.steps.some(
        (step) =>
          (step.key === `provision-intent:${key}` ||
            step.key.startsWith(`provision-intent:${key}:`)) &&
          step.resultHash === platformProvisionIntentHash(manifest, key, kind, name),
      ),
  );
  if (pending.length === 0) {
    return manifest;
  }
  const [workers, buckets] = await Promise.all([
    client.listWorkerNames(manifest.account.id),
    client.listR2Buckets(manifest.account.id),
  ]);
  let recovered = manifest;
  for (const [key, kind, name] of pending) {
    const live =
      kind === 'worker'
        ? workers.includes(name)
          ? { id: name, name }
          : null
        : (buckets.find((bucket) => bucket.name === name) ?? null);
    if (!live) {
      continue;
    }
    const resource: InstallationResource = {
      configHash: createHash('sha256').update(JSON.stringify({ kind, name })).digest('hex'),
      id: live.id,
      key,
      kind,
      name,
      ownership: 'created',
      state: 'ready',
    };
    const marker =
      kind === 'worker'
        ? (await client.getWorkerPlainTextBindings(manifest.account.id, name))
            .PLATFORM_OWNERSHIP_MARKER
        : await client.getR2Object(manifest.account.id, name, PLATFORM_R2_OWNERSHIP_MARKER_KEY);
    verifyResourceMarker(marker, manifest, resource);
    recovered = recordInstallationResource(recovered, resource, manifest.updatedAt);
  }
  return recovered;
}

const DATA_RESOURCE_KINDS = new Set([
  'ai-gateway',
  'dispatch-namespace',
  'hyperdrive',
  'kv-namespace',
  'r2-bucket',
]);

function isOwnershipVerifiableKind(kind: InstallationResource['kind']): boolean {
  return (
    kind === 'ai-gateway' ||
    kind === 'dispatch-namespace' ||
    kind === 'dns-record' ||
    kind === 'hyperdrive' ||
    kind === 'kv-namespace' ||
    kind === 'queue' ||
    kind === 'r2-bucket' ||
    kind === 'worker' ||
    kind === 'zone'
  );
}

function shouldDeleteResource(resource: InstallationResource, retainData: boolean): boolean {
  if (resource.state !== 'ready' || resource.ownership !== 'created') {
    return false;
  }
  if (resource.kind === 'zone') {
    return false;
  }
  // AI Gateway ids are caller-selected and can be reused after deletion. The
  // API exposes no durable ownership marker, so automatic deletion could
  // remove a replacement gateway created by another installation.
  if (resource.kind === 'ai-gateway') {
    return false;
  }
  // DNS record deletion is id-addressed but Cloudflare exposes no conditional
  // delete tied to the exact type/content/proxy tuple we verified. A dashboard
  // edit can retain the id while repurposing the record, so keep it for manual
  // cleanup instead of racing an unrelated production record.
  if (resource.kind === 'dns-record') {
    return false;
  }
  // Cloudflare exposes no server-enforced condition tying object deletion to
  // an R2 bucket generation. A same-name replacement can therefore race any
  // client-side ownership recheck. Retain R2 even during --purge-data and
  // require the operator to remove it explicitly in the Cloudflare dashboard.
  if (resource.kind === 'r2-bucket') {
    return false;
  }
  // Worker lifecycle mutations are name-addressed. Cloudflare exposes no
  // generation precondition that can prevent a same-name replacement from
  // racing the final ownership check, so retain Workers for manual cleanup.
  if (resource.kind === 'worker') {
    return false;
  }
  // Traffic attachments are removed only through their immutable Cloudflare
  // ids after tuple validation. Never pass an untracked or stale attachment to
  // the generic resource deleter.
  if (resource.kind === 'worker-route' || resource.kind === 'worker-custom-domain') {
    return false;
  }
  return !(retainData && DATA_RESOURCE_KINDS.has(resource.kind));
}

async function hasLiveInstallationWorker(
  client: Pick<PlatformManagementClient, 'listWorkerNames'>,
  manifest: PlatformInstallationManifest,
): Promise<boolean> {
  const names = manifest.deployment.resources;
  const installationWorkers = new Set([
    names.apiWorker,
    names.proxyWorker,
    names.emailGatewayWorker,
    names.tailWorker,
    names.dispatchWorker,
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.name),
  ]);
  return (await client.listWorkerNames(manifest.account.id)).some((name) =>
    installationWorkers.has(name),
  );
}

function resourceDeletionPriority(
  resource: InstallationResource,
  priorities: Readonly<Record<string, number>>,
): number {
  // The routing namespace contains the authoritative ownership checkpoint.
  // Delete it last so interrupted purges can still prove every earlier mutation.
  return resource.key === 'routing-kv' ? 100 : (priorities[resource.kind] ?? 99);
}

async function verifyPlatformMutationOwnership(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
  options: {
    allowDeletedRoutingCheckpoint?: boolean;
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
    databaseUrl?: string;
  } = {},
): Promise<ReadonlySet<string>> {
  const routing = requireResource(manifest, 'routing-kv');
  const targetResources = manifest.resources.filter(
    (resource) => targetKeys.has(resource.key) && resource.state === 'ready',
  );
  let rawRemote: string | null = null;
  let remote: PlatformInstallationManifest | null = null;
  let replacingMissingRoutingCheckpoint = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    rawRemote = await client.getKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (rawRemote !== null) {
      try {
        remote = parsePlatformInstallationManifest(JSON.parse(rawRemote) as unknown);
      } catch {
        throw ownershipError('the remote installation checkpoint is invalid');
      }
      if (
        remote.id !== manifest.id ||
        remote.ownershipNonce !== manifest.ownershipNonce ||
        remote.account.id !== manifest.account.id
      ) {
        throw ownershipError('the remote installation identity does not match this installation');
      }
      if (targetResources.every((resource) => hasMatchingResourceProof(remote!, resource))) {
        break;
      }
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
  if (rawRemote === null) {
    if (
      (options.allowMissingRoutingCheckpoint || options.allowUninitializedRoutingCheckpoint) &&
      routing.ownership === 'created'
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      const routingMatches = namespaces.some(
        (entry) => entry.id === routing.id && entry.name === routing.name,
      );
      const routingIdentityCollides = namespaces.some(
        (entry) => entry.id === routing.id || entry.name === routing.name,
      );
      if (
        (options.allowMissingRoutingCheckpoint && !routingIdentityCollides) ||
        (options.allowUninitializedRoutingCheckpoint && routingMatches)
      ) {
        // The caller holds the authoritative PostgreSQL lifecycle lock. Repair
        // or resume may use that manifest as the replacement checkpoint, but
        // every surviving resource must still pass fresh inventory and marker
        // checks. An existing routing namespace is accepted only with the
        // exact id and name recorded by the database-authoritative manifest.
        remote = manifest;
        replacingMissingRoutingCheckpoint = true;
      }
    }
    if (
      !replacingMissingRoutingCheckpoint &&
      options.allowDeletedRoutingCheckpoint &&
      canResumeAfterRoutingCheckpointDeletion(manifest, targetKeys)
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      if (!namespaces.some((entry) => entry.id === routing.id)) {
        return new Set([routing.key]);
      }
    }
    if (!replacingMissingRoutingCheckpoint) {
      throw ownershipError('the remote installation checkpoint is missing');
    }
  }
  if (!remote) {
    throw ownershipError('the remote installation checkpoint is missing');
  }

  const localAdvancesRemote = isPlatformManifestMonotonicExtension(remote, manifest);
  for (const resource of targetResources) {
    const proof = remote.resources.find((entry) => entry.key === resource.key);
    if (!hasMatchingResourceProof(remote, resource)) {
      if (
        !proof &&
        localAdvancesRemote &&
        resource.kind !== 'ai-gateway' &&
        hasMatchingResourceIntent(remote, resource)
      ) {
        continue;
      }
      throw ownershipError(`the remote checkpoint does not own ${resource.kind} ${resource.name}`);
    }
  }

  const missing = new Set<string>(replacingMissingRoutingCheckpoint ? [routing.key] : []);
  const accountId = manifest.account.id;
  const zone = manifest.resources.find((resource) => resource.key === 'zone');
  const inventory = await Promise.all([
    client.listAiGateways(accountId),
    client.listDispatchNamespaces(accountId),
    client.listHyperdriveConfigs(accountId),
    client.listKvNamespaces(accountId),
    client.listR2Buckets(accountId),
    client.listWorkerNames(accountId),
  ]);
  const [aiGateways, dispatchNamespaces, hyperdrives, kvNamespaces, r2Buckets, workerNames] =
    inventory;

  for (const resource of targetResources) {
    let exists = true;
    if (resource.kind === 'ai-gateway') {
      exists = hasNamedResource(aiGateways, resource);
    } else if (resource.kind === 'dispatch-namespace') {
      exists = hasNamedResource(dispatchNamespaces, resource);
    } else if (resource.kind === 'hyperdrive') {
      exists = hasNamedResource(hyperdrives, resource);
      if (exists) {
        const live = await client.getHyperdriveConfig(accountId, resource.id);
        exists = live.id === resource.id && live.name === resource.name;
        if (exists) {
          const legacyHash = createHash('sha256')
            .update(JSON.stringify({ kind: resource.kind, name: resource.name }))
            .digest('hex');
          const malformedLegacyHash = !/^[a-f0-9]{64}$/.test(resource.configHash);
          if (options.databaseUrl && resource.ownership !== 'adopted') {
            const expected = hyperdriveOriginFromConnectionString(options.databaseUrl);
            if (!hyperdriveOriginMatches(live.origin, expected)) {
              throw ownershipError(
                `hyperdrive ${resource.name} targets a different PostgreSQL origin than this installation's pinned database`,
              );
            }
            const expectedHash = hyperdriveOriginConfigHash(expected);
            if (
              resource.configHash !== expectedHash &&
              resource.configHash !== legacyHash &&
              !malformedLegacyHash
            ) {
              throw ownershipError(
                `hyperdrive ${resource.name} does not match the installation's database fingerprint`,
              );
            }
          } else if (
            resource.ownership === 'adopted' &&
            (resource.configHash !== hyperdriveOriginConfigHash(live.origin) ||
              (options.databaseUrl &&
                live.origin.database !== platformDatabaseNameFromOwnerUrl(options.databaseUrl)))
          ) {
            throw ownershipError(`hyperdrive ${resource.name} changed configuration`);
          } else if (
            resource.ownership !== 'adopted' &&
            resource.configHash !== hyperdriveOriginConfigHash(live.origin) &&
            resource.configHash !== legacyHash &&
            !malformedLegacyHash
          ) {
            throw ownershipError(`hyperdrive ${resource.name} changed configuration`);
          }
        }
      }
    } else if (resource.kind === 'kv-namespace') {
      exists = hasNamedResource(kvNamespaces, resource);
    } else if (resource.kind === 'queue') {
      exists = hasNamedResource(await client.listQueues(accountId, resource.name), resource);
    } else if (resource.kind === 'zone') {
      const current = await client.findZone(accountId, resource.name);
      exists = current?.id === resource.id;
    } else if (resource.kind === 'dns-record') {
      if (!zone) {
        exists = false;
      } else {
        const current = (await client.listDnsRecords(zone.id, resource.name)).find(
          (entry) => entry.id === resource.id && entry.name === resource.name,
        );
        exists = current !== undefined;
        if (current && resource.ownership === 'created') {
          const liveHash = dnsRecordConfigHash(
            current.name,
            current.type,
            current.content,
            current.proxied,
          );
          const legacyHash = createHash('sha256')
            .update(JSON.stringify({ kind: resource.kind, name: resource.name }))
            .digest('hex');
          const expectedHash = dnsRecordConfigHash(resource.name, 'AAAA', '100::', true);
          if (
            liveHash !== resource.configHash &&
            !(resource.configHash === legacyHash && liveHash === expectedHash)
          ) {
            throw ownershipError(
              `dns-record ${resource.name} changed configuration after installation`,
            );
          }
        }
      }
    } else if (resource.kind === 'worker') {
      exists = workerNames.includes(resource.name);
      if (exists) {
        const bindings = await client.getWorkerPlainTextBindings(accountId, resource.name);
        verifyResourceMarker(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, resource);
      }
    } else if (resource.kind === 'r2-bucket') {
      const live = r2Buckets.find(
        (entry) => entry.id === resource.id && entry.name === resource.name,
      );
      exists = live !== undefined;
      if (live) {
        const liveHash = live.fingerprint
          ? r2BucketConfigHash(resource.name, live.fingerprint)
          : null;
        const legacyHash = createHash('sha256')
          .update(JSON.stringify({ kind: resource.kind, name: resource.name }))
          .digest('hex');
        if (
          liveHash === null ||
          (resource.configHash !== liveHash && resource.configHash !== legacyHash)
        ) {
          throw ownershipError(`r2-bucket ${resource.name} changed creation fingerprint`);
        }
        const marker = await client.getR2Object(
          accountId,
          resource.name,
          PLATFORM_R2_OWNERSHIP_MARKER_KEY,
        );
        verifyResourceMarker(marker, manifest, resource);
      }
    } else {
      throw ownershipError(`live ownership checks do not support ${resource.kind}`);
    }
    if (!exists) {
      missing.add(resource.key);
    }
  }
  return missing;
}

function hasMatchingResourceProof(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  const proof = manifest.resources.find((entry) => entry.key === resource.key);
  return (
    proof?.id === resource.id &&
    proof.kind === resource.kind &&
    proof.name === resource.name &&
    proof.ownership === resource.ownership
  );
}

function hasMatchingResourceIntent(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  if (resource.ownership === 'created') {
    const previousResourceId =
      manifest.resources.find((entry) => entry.key === resource.key)?.id ?? null;
    return manifest.steps.some(
      (step) =>
        (step.key === `provision-intent:${resource.key}` ||
          step.key.startsWith(`provision-intent:${resource.key}:`)) &&
        step.resultHash ===
          platformProvisionIntentHash(
            manifest,
            resource.key,
            resource.kind,
            resource.name,
            previousResourceId,
          ),
    );
  }
  if (resource.ownership === 'adopted') {
    return manifest.steps.some(
      (step) =>
        step.key === `adoption-intent:${resource.key}` &&
        step.resultHash ===
          platformAdoptionIntentHash(
            manifest,
            resource.key,
            resource.kind,
            resource.id,
            resource.name,
          ),
    );
  }
  return false;
}

export function isPlatformManifestMonotonicExtension(
  earlier: PlatformInstallationManifest,
  later: PlatformInstallationManifest,
): boolean {
  if (
    earlier.id !== later.id ||
    earlier.ownershipNonce !== later.ownershipNonce ||
    earlier.account.id !== later.account.id ||
    earlier.createdAt !== later.createdAt ||
    JSON.stringify(earlier.deployment) !== JSON.stringify(later.deployment) ||
    Date.parse(later.updatedAt) < Date.parse(earlier.updatedAt)
  ) {
    return false;
  }
  const resourcesAdvance = earlier.resources.every((resource) => {
    const next = later.resources.find((entry) => entry.key === resource.key);
    return (
      next?.id === resource.id &&
      next.kind === resource.kind &&
      next.name === resource.name &&
      next.ownership === resource.ownership &&
      (next.state === resource.state ||
        (resource.state === 'ready' && (next.state === 'deleted' || next.state === 'retained')))
    );
  });
  const stepsAdvance = earlier.steps.every((step) =>
    later.steps.some(
      (entry) =>
        entry.key === step.key &&
        entry.completedAt === step.completedAt &&
        entry.resultHash === step.resultHash,
    ),
  );
  const authenticationResourcesAdvance = (earlier.authenticationResources ?? []).every((resource) =>
    (later.authenticationResources ?? []).some(
      (next) => JSON.stringify(next) === JSON.stringify(resource),
    ),
  );
  return resourcesAdvance && stepsAdvance && authenticationResourcesAdvance;
}

function hasNamedResource(
  entries: ReadonlyArray<{ id: string; name: string }>,
  resource: InstallationResource,
): boolean {
  return entries.some((entry) => entry.id === resource.id && entry.name === resource.name);
}

function dnsRecordConfigHash(
  name: string,
  type: string,
  content: string,
  proxied: boolean,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ content, kind: 'dns-record', name, proxied, type }))
    .digest('hex');
}

function r2BucketConfigHash(name: string, fingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ fingerprint, kind: 'r2-bucket', name }))
    .digest('hex');
}

function verifyResourceMarker(
  value: string | null | undefined,
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): void {
  if (!value) {
    throw ownershipError(`${resource.kind} ${resource.name} has no ownership marker`);
  }
  let actual;
  try {
    actual = parsePlatformResourceOwnershipMarker(JSON.parse(value) as unknown);
  } catch {
    throw ownershipError(`${resource.kind} ${resource.name} has an invalid ownership marker`);
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId: manifest.account.id,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: resource.id,
    resourceKey: resource.key,
    resourceKind: resource.kind,
    resourceName: resource.name,
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw ownershipError(`${resource.kind} ${resource.name} belongs to another installation`);
  }
}

function canResumeAfterRoutingCheckpointDeletion(
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
): boolean {
  if (manifest.status !== 'failed' && manifest.status !== 'uninstalling') {
    return false;
  }
  return manifest.resources.every(
    (resource) =>
      resource.key === 'routing-kv' || !targetKeys.has(resource.key) || resource.state !== 'ready',
  );
}

function ownershipError(reason: string): Error {
  return new Error(
    `platform: Refusing to change Cloudflare resources because ${reason}. Run \`void platform repair\` to restore ownership proofs before retrying.`,
  );
}

function requireResource(manifest: PlatformInstallationManifest, key: string) {
  const resource = manifest.resources.find((entry) => entry.key === key);
  if (!resource) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return resource;
}

function updateResourceState(
  manifest: PlatformInstallationManifest,
  key: string,
  state: 'deleted' | 'retained',
): PlatformInstallationManifest {
  const resource = requireResource(manifest, key);
  return recordInstallationResource(manifest, { ...resource, state }, new Date().toISOString());
}

function markTrafficAttachmentsRetained(
  manifest: PlatformInstallationManifest,
): PlatformInstallationManifest {
  let next = manifest;
  for (const resource of manifest.resources) {
    if (
      resource.state === 'ready' &&
      (resource.kind === 'worker-route' || resource.kind === 'worker-custom-domain')
    ) {
      next = updateResourceState(next, resource.key, 'retained');
    }
  }
  return next;
}

function hasLifecycleStep(manifest: PlatformInstallationManifest, key: string): boolean {
  return manifest.steps.some((step) => step.key === key);
}

function currentTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return Math.max(
    0,
    ...manifest.steps.flatMap((step) => {
      const match = /^traffic-enabled:(\d+)$/.exec(step.key);
      return match ? [Number(match[1])] : [];
    }),
  );
}

function recordLifecycleStep(
  manifest: PlatformInstallationManifest,
  key: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  return recordInstallationStep(manifest, { completedAt: now, key, resultHash: 'completed' }, now);
}

async function writeLifecycleCheckpointWithoutDatabase(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  writeInstallationManifest(manifest);
  await writeRemoteManifestIfPresentWithoutDatabase(client, manifest, databaseCheckpoint);
}

async function writeRemoteManifestIfPresentWithoutDatabase(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  await databaseCheckpoint?.(manifest);
  const routing = manifest.resources.find(
    (resource) => resource.key === 'routing-kv' && resource.state !== 'deleted',
  );
  if (routing) {
    await client.putKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
      JSON.stringify(manifest),
    );
  }
}

async function promptForConfirmation(message: string, initialValue: boolean): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer) || typeof answer === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return answer;
}
