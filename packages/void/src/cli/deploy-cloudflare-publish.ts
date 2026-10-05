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
import {
  createActiveSecretPinner,
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
} from './cf-version-runner.ts';
import {
  assertCloudflareCandidateUnchanged,
  clearCloudflareCandidate,
  readCloudflareCandidate,
  recordCloudflareCandidateUpload,
} from './cloudflare-candidate.ts';
import {
  completeCloudflareLink,
  recordCloudflareCandidate,
  assertCloudflareLinkUnchanged,
  type CloudflareLink,
} from './cloudflare-link.ts';
import {
  createCloudflareEmptyCronPublisher,
  createCloudflareEmptyDomainPublisher,
} from './cloudflare-operations.ts';
import { rememberCloudflareWorkersDevSubdomain } from './cloudflare-readiness.ts';
import { runWranglerAuthToken } from './deploy-cloudflare-auth.ts';
import {
  activateCloudflareVersionWithProgress,
  cloudflareWorkerReadinessHeaders,
  reportCloudflareActivationFailure,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import { prepareCloudflareDeploySource } from './deploy-cloudflare-preflight.ts';
import { log } from './deploy-helpers.ts';
import { formatCloudflareSandboxUnavailable, BETTER_AUTH_SECRET_NAME } from './deploy-resources.ts';
import { formatDeploySummary } from './deploy-summary.ts';
import { deployChildEnv } from './deploy-transport.ts';
import { type CloudflareDeployDeps } from './deploy-types.ts';
import { type SelfHostSchemaFacts } from './env-validation.ts';
import { type CliLogger } from './log-file.ts';
import { note } from './output.ts';
import {
  acknowledgeWranglerManagedQueueRemovals,
  readWranglerManagedQueueCleanupCandidates,
  readWranglerPublishedTrafficSnapshot,
  writeWranglerPublishedTrafficSnapshot,
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
  if (existingWorker) {
    assertCloudflareLinkUnchanged(root, pinnedHandoffLink);
  }
  assertCloudflareCandidateUnchanged(root, initialCloudflareCandidate);
  if (
    initialCloudflareCandidate &&
    (initialCloudflareCandidate.accountId !== accountId ||
      initialCloudflareCandidate.workerName !== workerName)
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different account or Worker. Inspect its receipt before retrying.',
    );
  }
  const candidateReceipt = pinnedHandoffLink?.candidateReceipt;
  if (!deps.activateVersion && !deps.runWrangler && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = deps.activateVersion || deps.runWrangler ? null : await prepareBuildOutput();
  if (!cfOutput && !deps.activateVersion && !deps.runWrangler) {
    log.error('deploy: cf could not prepare the built Worker for deployment.');
    return exit(1);
  }
  const cfCommand = cfOutput
    ? createCfCommand({
        accountId: accountId,
        apiBaseUrl: apiBaseUrl,
        env: deployChildEnv,
        verifyUploader: cfUploaderIsPinned,
      })
    : null;
  const activationRunner =
    cfOutput && cfCommand
      ? createCfVersionRunner({
          output: cfOutput,
          workerName: workerName,
          runCf: cfCommand,
          pinnedUpload: {
            accountId: accountId,
            apiBaseUrl: apiBaseUrl,
            getToken: () => runWranglerAuthToken(runWrangler, generatedConfigPath),
            verifyUploader: cfUploaderIsPinned,
          },
          verifyResources: createCfResourceVerifier({
            configPath: generatedConfigPath,
            runCf: cfCommand,
            runWrangler: runWrangler,
            verifyCompatibilityRunner: assertUploaderStillPinned,
          }),
        })
      : runWrangler;
  const pinActiveSecrets = createActiveSecretPinner({
    output: cfOutput,
    handoffPending: pinnedHandoffLink !== null,
    requiredNames: schemaFacts.requiredKeys,
    ...(initialAuthSecret ? { explicitNames: [BETTER_AUTH_SECRET_NAME] } : {}),
  });
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      workerName: workerName,
      configPath: generatedConfigPath,
      preserveTriggers: existingWorker !== null,
      requireVersionMetadata:
        existingWorker === null ||
        readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) !== undefined,
      requirePreviewForReadiness:
        existingWorker !== null &&
        readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) === undefined,
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
              runWrangler: runWrangler,
              configPath: generatedConfigPath,
              workerName: workerName,
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
      workersDevSubdomain: workersDevSubdomain,
      readinessHeadersWorkersDevSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim()
        ? workersDevSubdomain
        : undefined,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher({
        accountId: accountId,
        apiBaseUrl: apiBaseUrl,
        configPath: generatedConfigPath,
        workerName: workerName,
        runWrangler: runWrangler,
      }),
      publishEmptyCrons: createCloudflareEmptyCronPublisher({
        accountId: accountId,
        apiBaseUrl: apiBaseUrl,
        configPath: generatedConfigPath,
        workerName: workerName,
        runWrangler: runWrangler,
      }),
      previousTrafficConfig: readWranglerPublishedTrafficSnapshot(configPath),
      queueConsumerCleanup,
      verifyInheritedSecrets: true,
      ...(pinActiveSecrets ? { pinActiveSecrets } : {}),
      atomic: atomic,
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
  clearCloudflareCandidate(root);
  if (existingWorker) {
    completeCloudflareLink(root);
  }
  acknowledgeWranglerManagedQueueRemovals(configPath, queueConsumerCleanup);
  rememberCloudflareWorkersDevSubdomain(root, accountId, execution.previewUrl);
  if (execution.trafficConfig) {
    writeWranglerPublishedTrafficSnapshot(
      configPath,
      {
        workers_dev: execution.trafficConfig.workers_dev,
        preview_urls: execution.trafficConfig.preview_urls,
        routes: [...execution.trafficConfig.routes],
      },
      { create: false },
    );
  }
  cliLog.info('cloudflare_deploy_end', {
    ok: true,
    worker: workerName,
    versionId: execution.versionId,
  });
  note(
    formatDeploySummary({
      workerName: workerName,
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
