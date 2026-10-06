import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  readExistingCloudflareWorker,
  assertCloudflareBindingsPreserved,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { collectMigrations } from '../migrations/collect.ts';
import { detectFramework } from '../plugin-inference.ts';
import { readVersionMetadataBinding } from '../shared/version-metadata.ts';
import { prepareCfBuildOutput } from './cf-build-output.ts';
import { createActiveSecretPinner } from './cf-version-runner.ts';
import {
  clearCloudflareCandidate,
  readCloudflareCandidate,
  recordCloudflareCandidateUpload,
} from './cloudflare-candidate.ts';
import { recordCloudflareCandidate, type CloudflareLink } from './cloudflare-link.ts';
import {
  activateCloudflareVersionWithProgress,
  assertCloudflareDeployTargetUnchanged,
  cloudflareWorkerReadinessHeaders,
  createCfActivationRunner,
  createCloudflareEmptyTriggerPublishers,
  recordCloudflareActivation,
  reportCloudflareActivationFailure,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import { prepareCloudflareDeploySource } from './deploy-cloudflare-preflight.ts';
import { log } from './deploy-helpers.ts';
import { formatCloudflareSandboxUnavailable, BETTER_AUTH_SECRET_NAME } from './deploy-resources.ts';
import { formatDeploySummary } from './deploy-summary.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type SelfHostSchemaFacts } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
import { note } from './output.ts';
import {
  readWranglerManagedQueueCleanupCandidates,
  readWranglerPublishedTrafficSnapshot,
} from './wrangler.ts';

export async function publishCloudflareWorker(input: {
  readonly configPath: string;
  readonly existingWorker: ExistingCloudflareWorker | null;
  readonly root: string;
  readonly pinnedHandoffLink: CloudflareLink | null;
  readonly initialCloudflareCandidate: ReturnType<typeof readCloudflareCandidate>;
  readonly accountId: string;
  readonly workerName: string;
  readonly deps: CloudflareDeployDeps;
  readonly cfUploaderIsPinned: () => boolean;
  readonly exit: (code: number) => never;
  readonly prepareBuildOutput: () => ReturnType<typeof prepareCfBuildOutput>;
  readonly apiBaseUrl: string;
  readonly runWrangler: NonNullable<CloudflareDeployDeps['runWrangler']>;
  readonly generatedConfigPath: string;
  readonly assertUploaderStillPinned: () => boolean;
  readonly schemaFacts: SelfHostSchemaFacts;
  readonly initialAuthSecret: string | undefined;
  readonly approvedHandoffKv: Array<ApprovedCloudflareKvBinding>;
  readonly migrations: ReturnType<typeof collectMigrations>;
  readonly workerWasMissingBeforeSecretProvisioning: boolean;
  readonly workersDevSubdomain: string | undefined;
  readonly atomic: boolean;
  readonly cliLog: CliLogger;
  readonly needsSandbox: boolean;
  readonly appliedMigrations: number;
  readonly d1MigrateToken: string | undefined;
  readonly source: NonNullable<Awaited<ReturnType<typeof prepareCloudflareDeploySource>>>;
  readonly desired: import('./provision.ts').DesiredResourceSet;
  readonly detectedFramework: ReturnType<typeof detectFramework>;
}): Promise<void> {
  const {
    configPath,
    existingWorker,
    root,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
    deps,
    cfUploaderIsPinned,
    exit,
    prepareBuildOutput,
    apiBaseUrl,
    runWrangler,
    generatedConfigPath,
    assertUploaderStillPinned,
    schemaFacts,
    initialAuthSecret,
    approvedHandoffKv,
    migrations,
    workerWasMissingBeforeSecretProvisioning,
    workersDevSubdomain,
    atomic,
    cliLog,
    needsSandbox,
    appliedMigrations,
    d1MigrateToken,
    source,
    desired,
    detectedFramework,
  } = input;

  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  assertCloudflareDeployTargetUnchanged({
    root,
    existingWorker,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
  });
  const candidateReceipt = pinnedHandoffLink?.candidateReceipt;
  const usesCf = !deps.activateVersion && !deps.runWrangler;
  if (usesCf && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = usesCf ? await prepareBuildOutput() : null;
  if (!cfOutput && usesCf) {
    log.error('deploy: cf could not prepare the built Worker for deployment.');
    return exit(1);
  }
  const activationRunner = createCfActivationRunner({
    cfOutput,
    accountId,
    apiBaseUrl,
    workerName,
    configPath: generatedConfigPath,
    runWrangler,
    cfUploaderIsPinned,
    verifyCompatibilityRunner: assertUploaderStillPinned,
  });
  const pinActiveSecrets = createActiveSecretPinner({
    output: cfOutput,
    handoffPending: pinnedHandoffLink !== null,
    requiredNames: schemaFacts.requiredKeys,
    ...(initialAuthSecret ? { explicitNames: [BETTER_AUTH_SECRET_NAME] } : {}),
  });
  const hasVersionMetadata =
    readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) !== undefined;
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      workerName,
      configPath: generatedConfigPath,
      preserveTriggers: existingWorker !== null,
      requireVersionMetadata: existingWorker === null || hasVersionMetadata,
      requirePreviewForReadiness: existingWorker !== null && !hasVersionMetadata,
      expectedPreviousVersionId: existingWorker?.versionId,
      trustedInheritanceVersionIds: existingWorker
        ? candidateReceipt?.parentVersionId === existingWorker.versionId
          ? candidateReceipt.versionIds
          : undefined
        : initialCloudflareCandidate?.versionIds,
      validateUploadedVersion: existingWorker
        ? async (versionId) => {
            if (!assertUploaderStillPinned()) {
              throw new Error('The deployment uploader changed.');
            }
            const uploaded = await (deps.readExistingWorker ?? readExistingCloudflareWorker)({
              runWrangler,
              configPath: generatedConfigPath,
              workerName,
              versionId,
            });
            assertCloudflareBindingsPreserved(existingWorker, uploaded, approvedHandoffKv);
          }
        : undefined,
      recordVerifiedCandidate: existingWorker
        ? (versionId) =>
            recordCloudflareCandidate(root, pinnedHandoffLink!, existingWorker.versionId, versionId)
        : (versionId, parentVersionId) => {
            if (parentVersionId) {
              recordCloudflareCandidateUpload(
                root,
                initialCloudflareCandidate,
                accountId,
                workerName,
                parentVersionId,
                versionId,
              );
            }
          },
      message: encodeCloudflareVersionMessage(
        migrations.map((migration) => migration.name),
        {
          ...readCloudflareTriggerConfig(generatedConfigPath, configPath),
          ...(existingWorker ? { preserve: true } : {}),
        },
      ),
      allowFirstDeploymentBootstrap: workerWasMissingBeforeSecretProvisioning,
      readinessHeaders: cloudflareWorkerReadinessHeaders(),
      workersDevSubdomain,
      readinessHeadersWorkersDevSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim()
        ? workersDevSubdomain
        : undefined,
      ...createCloudflareEmptyTriggerPublishers({
        accountId,
        apiBaseUrl,
        configPath: generatedConfigPath,
        workerName,
        runWrangler,
      }),
      previousTrafficConfig: readWranglerPublishedTrafficSnapshot(configPath),
      queueConsumerCleanup,
      verifyInheritedSecrets: true,
      ...(pinActiveSecrets ? { pinActiveSecrets } : {}),
      atomic,
      ...(initialAuthSecret
        ? { candidateSecrets: { [BETTER_AUTH_SECRET_NAME]: initialAuthSecret } }
        : {}),
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    if (
      execution.reason === 'atomic-readiness-failed' ||
      execution.reason === 'atomic-readiness-access-denied'
    ) {
      // The atomic command published successfully; the old inactive-candidate chain
      // no longer describes the live parent for the next deploy.
      clearCloudflareCandidate(root);
    }
    await reportCloudflareActivationFailure(
      cliLog,
      needsSandbox && execution.containersUnavailable
        ? formatCloudflareSandboxUnavailable()
        : formatCloudflareActivationError(execution),
    );
    return exit(1);
  }
  recordCloudflareActivation({
    root,
    configPath,
    accountId,
    workerName,
    existingWorker,
    queueConsumerCleanup,
    execution,
    cliLog,
  });
  note(
    formatDeploySummary({
      workerName,
      migrations: appliedMigrations,
      d1MigrationsCurrent: d1MigrateToken !== undefined,
      // Existing Worker handoffs preserve remote triggers rather than publishing source jobs.
      cronJobs: existingWorker ? undefined : source.analysis.jobs.length,
      queues: existingWorker ? undefined : desired.queues.length,
      framework: detectedFramework?.name,
    }),
    execution.previewUrl,
  );
}
