import { createHash, randomBytes } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  platformDashboardUrl,
  transitionInstallation,
  type PlatformDeploymentManifest,
  type PlatformInstallationManifest,
  parsePlatformAuthenticationSetup,
} from '@void/platform';
import type { PlatformRuntimeManifest } from '@void/platform/installer';
import { ensurePlatformAccessHealthChecks } from './platform-access-health.ts';
import { verifyInstalledPlatformAccessProtection } from './platform-access-preflight.ts';
import {
  activatePlatformAccessCredentials,
  isPlatformAuthenticationPreparationKey,
} from './platform-access-setup.ts';
import { PlatformAppAccessCredentialError } from './platform-app-access.ts';
import { PlatformCloudflareApiError } from './platform-cloudflare.ts';
import { verifyPlatformDeploymentExecutionDrain } from './platform-installer-health.ts';
import {
  assertRequiredPlatformSecrets,
  secretCheckpoint,
  checkpointAuthenticationResources,
  createPlatformHealthProbeToken,
} from './platform-installer-secrets.ts';
import {
  type PlatformDatabaseLifecycleLock,
  type PlatformInstallerDependencies,
  type PlatformInstallationSecrets,
  type PlatformWorkerSecretUpdateIntent,
  mergePlatformLiveAuthenticationDeployment,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan } from './platform-plan.ts';
import {
  readPendingInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';

function withAuthentication(
  deployment: PlatformDeploymentManifest,
  authentication: PlatformDeploymentManifest['authentication'],
): PlatformDeploymentManifest {
  return createPlatformDeploymentManifest({
    ...deployment,
    authentication,
    capabilities: {
      ...deployment.capabilities,
      githubOAuth: authentication.providers.includes('github'),
      googleOAuth: authentication.providers.includes('google'),
    },
  });
}

export async function prepareInstallationAuthentication(input: {
  readonly releaseDatabaseLock: PlatformDatabaseLifecycleLock;
  authenticationEnforcementActive: boolean;
  readonly runtime: PlatformRuntimeManifest;
  plan: PlatformInstallPlan;
  readonly authenticationProtocolTransition: boolean;
  manifest: PlatformInstallationManifest;
  secrets: PlatformInstallationSecrets;
  readonly now: () => string;
  readonly dependencies: PlatformInstallerDependencies;
  readonly workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null;
}): Promise<void> {
  const {
    releaseDatabaseLock,
    runtime,
    authenticationProtocolTransition,
    now,
    dependencies,
    workerSecretUpdateIntent,
  } = input;

  const liveAuthentication = await releaseDatabaseLock.readAuthenticationState?.();
  if (liveAuthentication) {
    input.authenticationEnforcementActive = liveAuthentication.sessionsRequired;
    if (liveAuthentication.sessionsRequired && runtime.authenticationProtocolVersion !== 1) {
      throw new Error(
        'platform: This runtime cannot enforce the active authentication configuration. Use an authentication-compatible runtime.',
      );
    }
    const deployment = mergePlatformLiveAuthenticationDeployment(
      input.plan.deployment,
      liveAuthentication,
    );
    input.plan = { ...input.plan, deployment };
    if (!authenticationProtocolTransition) {
      input.manifest = { ...input.manifest, deployment };
    }
  }
  if (
    !liveAuthentication &&
    input.manifest.deployment.authentication.configurable &&
    !input.plan.deployment.authentication.configurable
  ) {
    input.plan = {
      ...input.plan,
      deployment: withAuthentication(
        input.plan.deployment,
        input.manifest.deployment.authentication,
      ),
    };
  }
  if (authenticationProtocolTransition && !input.plan.deployment.authentication.configurable) {
    input.plan = {
      ...input.plan,
      deployment: withAuthentication(input.plan.deployment, {
        providers: input.plan.deployment.authentication.providers,
        configurable: true,
      }),
    };
  }
  const activateAccessCredentials = () => {
    if (!input.secrets.accessCredentialsJson) {
      return;
    }
    const credentials: unknown = JSON.parse(input.secrets.accessCredentialsJson);
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('platform: Invalid saved Access credentials.');
    }
    // Lifecycle HTTP calls use API/proxy origins. Retain optional dashboard credentials
    // in recovery storage without activating them, including after protection removal.
    const origins = [input.plan.apiUrl, input.plan.proxyUrl];
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
  input.manifest = checkpointAuthenticationResources(input.manifest, input.secrets, now());
  writeInstallationManifest(input.manifest);
  await releaseDatabaseLock.checkpoint?.(input.manifest);
  dependencies.onProgress?.('Checking and creating Cloudflare resources');
  if (
    !authenticationProtocolTransition &&
    JSON.stringify(input.manifest.deployment) !== JSON.stringify(input.plan.deployment)
  ) {
    input.manifest = {
      ...input.manifest,
      deployment: input.plan.deployment,
      updatedAt: now(),
    };
    writeInstallationManifest(input.manifest);
    await releaseDatabaseLock.checkpoint?.(input.manifest);
  }
  if (input.manifest.status !== 'provisioning') {
    input.manifest = transitionInstallation(input.manifest, 'provisioning', now());
    writeInstallationManifest(input.manifest);
  }
  if (
    runtime.deploymentExecution !== 1 &&
    (input.manifest.deploymentExecution === 1 ||
      dependencies.databaseRollbackSource?.manifest.deploymentExecution === 1)
  ) {
    // Admission takes a shared row lock on this authoritative checkpoint in the
    // transaction that creates its deployment job. This update closes admission
    // before the probe counts jobs, and before a Queue consumer can be removed.
    if (!releaseDatabaseLock.checkpoint) {
      throw new Error('platform: The database lifecycle lock cannot fence deployment admission.');
    }
    await releaseDatabaseLock.checkpoint(input.manifest);
    dependencies.onProgress?.('Verifying durable deployment operations have drained');
    await (dependencies.verifyDeploymentExecutionDrain ?? verifyPlatformDeploymentExecutionDrain)(
      input.plan.apiUrl,
      createPlatformHealthProbeToken(input.manifest.ownershipNonce),
      input.manifest.id,
    );
  }

  if (dependencies.prepareAuthentication) {
    dependencies.onProgress?.('Preparing platform authentication');
    try {
      input.secrets = {
        ...input.secrets,
        ...(await dependencies.prepareAuthentication(input.manifest, input.secrets)),
      };
    } catch (error) {
      // Preserve provider secrets/ambiguous-create intents written while the preparation
      // hook was running; the outer failure checkpoint must not erase that recovery data.
      const latest = readPendingInstallationSecrets(input.manifest) ?? {};
      input.secrets = {
        ...input.secrets,
        authenticationPreparation: Object.fromEntries(
          Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
        ),
        authenticationSetupJson:
          latest.authenticationSetupJson || input.secrets.authenticationSetupJson,
        authSetupToken: latest.authSetupToken || input.secrets.authSetupToken,
        authBootstrapCode: latest.authBootstrapCode || input.secrets.authBootstrapCode,
        accessProvisioningJson:
          latest.accessProvisioningJson || input.secrets.accessProvisioningJson,
        accessCredentialsJson: latest.accessCredentialsJson || input.secrets.accessCredentialsJson,
      };
      input.manifest = checkpointAuthenticationResources(input.manifest, input.secrets, now());
      writeInstallationManifest(input.manifest);
      await releaseDatabaseLock.checkpoint?.(input.manifest);
      throw error;
    }
    const latest = readPendingInstallationSecrets(input.manifest) ?? {};
    input.secrets = {
      ...input.secrets,
      authenticationPreparation: Object.fromEntries(
        Object.entries(latest).filter(([name]) => isPlatformAuthenticationPreparationKey(name)),
      ),
    };
    input.manifest = checkpointAuthenticationResources(input.manifest, input.secrets, now());
    writeInstallationManifest(input.manifest);
    await releaseDatabaseLock.checkpoint?.(input.manifest);
    activateAccessCredentials();
    assertRequiredPlatformSecrets(input.plan, input.manifest, input.secrets);
    if (
      input.secrets.authenticationSetupJson &&
      createHash('sha256')
        .update(input.secrets.authBootstrapCode ?? '')
        .digest('hex') !==
        parsePlatformAuthenticationSetup(JSON.parse(input.secrets.authenticationSetupJson))
          .bootstrapCredentialHash
    ) {
      throw new Error(
        'platform: Prepared authentication does not match its administrator setup code.',
      );
    }
    writePendingInstallationSecrets(input.manifest, {
      ...secretCheckpoint(input.secrets, workerSecretUpdateIntent),
      databaseClaimState: 'claimed',
    });
  }

  const appAccessSetupRequired =
    !!input.plan.deployment.appAccess &&
    !input.manifest.steps.some((step) => step.key === 'app-access-initialized:v1');
  if (appAccessSetupRequired) {
    if (dependencies.prepareAppAccess) {
      try {
        const appAccessSetupJson = await dependencies.prepareAppAccess(
          input.manifest,
          input.secrets,
        );
        const latest = readPendingInstallationSecrets(input.manifest) ?? {};
        input.secrets = {
          ...input.secrets,
          appAccessSetupJson,
          authenticationPreparation: Object.fromEntries(
            Object.entries(latest).filter(([key]) => isPlatformAuthenticationPreparationKey(key)),
          ),
        };
        writePendingInstallationSecrets(input.manifest, {
          ...secretCheckpoint(input.secrets, workerSecretUpdateIntent),
          databaseClaimState: 'claimed',
        });
      } catch (error) {
        const latest = readPendingInstallationSecrets(input.manifest) ?? {};
        input.secrets = {
          ...input.secrets,
          appAccessSetupJson: latest.appAccessSetupJson || input.secrets.appAccessSetupJson,
          authenticationPreparation: Object.fromEntries(
            Object.entries(latest).filter(([key]) => isPlatformAuthenticationPreparationKey(key)),
          ),
        };
        throw error;
      }
    }
    if (!input.secrets.appAccessSetupJson) {
      throw new Error(
        'platform: Restore the encrypted app access setup checkpoint before resuming.',
      );
    }
    if (!input.secrets.appAccessSetupToken) {
      if (
        input.manifest.resources.some(
          (resource) => resource.key === 'api-worker' && resource.state === 'ready',
        )
      ) {
        throw new Error(
          'platform: Restore the encrypted app access setup authority before resuming.',
        );
      }
      input.secrets = { ...input.secrets, appAccessSetupToken: randomBytes(32).toString('hex') };
      writePendingInstallationSecrets(input.manifest, {
        ...secretCheckpoint(input.secrets, workerSecretUpdateIntent),
        databaseClaimState: 'claimed',
      });
    }
  }
  if (input.plan.deployment.authentication.accessProtection) {
    const protection = liveAuthentication
      ? liveAuthentication.protection
      : input.secrets.authenticationSetupJson
        ? parsePlatformAuthenticationSetup(JSON.parse(input.secrets.authenticationSetupJson))
            .protection
        : null;
    if (!protection) {
      throw new Error(
        'platform: The active Access protection configuration is unavailable. Restore its database and encrypted setup checkpoint before maintenance.',
      );
    }
    dependencies.onProgress?.('Verifying current Access policies and protected origins');
    await (dependencies.verifyAccessProtection ?? verifyInstalledPlatformAccessProtection)({
      client: dependencies.client,
      manifest: input.manifest,
      plan: input.plan,
      dashboardUrl: platformDashboardUrl(input.plan.deployment),
      protection,
      checkpoint: secretCheckpoint(input.secrets, workerSecretUpdateIntent),
    });
  }
  if (
    input.plan.deployment.authentication.accessProtection ||
    (appAccessSetupRequired &&
      input.secrets.appAccessSetupJson &&
      JSON.parse(input.secrets.appAccessSetupJson).managed === true)
  ) {
    dependencies.onProgress?.('Preparing Access for authenticated platform health checks');
    try {
      await (dependencies.prepareHealthAccess ?? ensurePlatformAccessHealthChecks)({
        client: dependencies.client,
        manifest: input.manifest,
        plan: input.plan,
        checkpoint: secretCheckpoint(input.secrets, workerSecretUpdateIntent),
        save: (accessHealthProvisioningJson) => {
          input.secrets = { ...input.secrets, accessHealthProvisioningJson };
          input.manifest = checkpointAuthenticationResources(input.manifest, input.secrets, now());
          writePendingInstallationSecrets(input.manifest, {
            ...secretCheckpoint(input.secrets, workerSecretUpdateIntent),
            databaseClaimState: 'claimed',
          });
          writeInstallationManifest(input.manifest);
        },
      });
    } catch (error) {
      if (
        appAccessSetupRequired &&
        input.secrets.appAccessSetupJson &&
        JSON.parse(input.secrets.appAccessSetupJson).managed &&
        error instanceof PlatformCloudflareApiError &&
        [401, 403].includes(error.status)
      ) {
        input.secrets = {
          ...input.secrets,
          authenticationPreparation: {
            ...input.secrets.authenticationPreparation,
            appAccessTokenRejected: 'true',
          },
        };
        writePendingInstallationSecrets(
          input.manifest,
          secretCheckpoint(input.secrets, workerSecretUpdateIntent),
        );
        throw new PlatformAppAccessCredentialError(
          'platform: App access token rejected while preparing health checks. Resume installation to provide a replacement.',
        );
      }
      throw error;
    } finally {
      await releaseDatabaseLock.checkpoint?.(input.manifest);
    }
  }
}
