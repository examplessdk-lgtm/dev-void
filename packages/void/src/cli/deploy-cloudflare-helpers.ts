import { existsSync } from 'node:fs';
import {
  activateCloudflareVersion,
  type CloudflareCommandRunner,
  type ExistingCloudflareWorker,
} from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { materializeCloudflareConfig } from '../cloudflare-config.ts';
import { trustedCloudflareWorkerAccessHeaders } from '../shared/cf-access.ts';
import type { CfBuildOutput } from './cf-build-output.ts';
import {
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
} from './cf-version-runner.ts';
import { CloudflareAuthenticationError } from './cloudflare-auth.ts';
import {
  assertCloudflareCandidateUnchanged,
  clearCloudflareCandidate,
  type CloudflareCandidateReceipt,
} from './cloudflare-candidate.ts';
import {
  assertCloudflareLinkUnchanged,
  completeCloudflareLink,
  type CloudflareLink,
} from './cloudflare-link.ts';
import {
  createCloudflareEmptyCronPublisher,
  createCloudflareEmptyDomainPublisher,
} from './cloudflare-operations.ts';
import { rememberCloudflareWorkersDevSubdomain } from './cloudflare-readiness.ts';
import {
  assertWranglerUploaderUnchanged,
  hashCfUploader,
  hashWranglerUploader,
} from './deploy-binding-snapshot.ts';
import { runWranglerAuthToken } from './deploy-cloudflare-auth.ts';
import { getErrorMessage, log } from './deploy-helpers.ts';
import { deployChildEnv } from './deploy-transport.ts';
import type { CloudflareDeployDeps, DeployWranglerRun } from './deploy-types.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner } from './output.ts';
import {
  acknowledgeWranglerManagedQueueRemovals,
  writeWranglerPublishedTrafficSnapshot,
  type readWranglerManagedQueueCleanupCandidates,
} from './wrangler.ts';

type CloudflareActivationResult = Awaited<ReturnType<typeof activateCloudflareVersion>>;

/**
 * Discover the root wrangler config path the same way the build / bindings
 * writer do (wrangler.jsonc first, then wrangler.json). Falls back to the
 * default wrangler.jsonc path when none exists yet — the provisioner creates it.
 */
export function discoverRootWranglerConfig(root: string): string {
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment needs one root wrangler.jsonc or wrangler.json with the same settings. Convert the config before deploying.',
    );
  }
  return materializeCloudflareConfig(root);
}

/**
 * Pin both uploaders before the first authenticated command. Every later credentialed run
 * checks the same baseline, so project code can never swap the executable under the session.
 * Injected test runners (`activateVersion` / `runWrangler`) bypass the pinned cf uploader.
 */
export function createCloudflareUploaderPins(
  root: string,
  deps: CloudflareDeployDeps,
): {
  usesCf: boolean;
  cfUploaderIsPinned: () => boolean;
  assertUploaderStillPinned: () => boolean;
} {
  const usesCf = !deps.activateVersion && !deps.runWrangler;
  const hashUploader = deps.hashWranglerUploader ?? hashWranglerUploader;
  const wranglerUploaderHashBefore = hashUploader(root);
  const cfUploaderHashBefore = usesCf ? hashCfUploader() : undefined;
  return {
    usesCf,
    cfUploaderIsPinned: () => {
      const matched =
        cfUploaderHashBefore !== undefined && cfUploaderHashBefore === hashCfUploader();
      if (!matched) {
        log.error('deploy: refusing to run a changed cf uploader with Cloudflare credentials.');
      }
      return matched;
    },
    assertUploaderStillPinned: () => {
      const check = assertWranglerUploaderUnchanged(wranglerUploaderHashBefore, hashUploader(root));
      if (!check.ok) {
        log.error(
          [
            'deploy: refusing to run the Cloudflare uploader with your Cloudflare credentials.',
            check.reason,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      return check.ok;
    },
  };
}

/** Log a failed Cloudflare sign-in. An uploader change has already reported itself. */
export function logCloudflareAuthFailure(error: unknown): void {
  if (!(error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed')) {
    log.error(`deploy: ${getErrorMessage(error)}`);
  }
}

/** Fail before upload when the handoff link or saved candidate no longer matches this deploy. */
export function assertCloudflareDeployTargetUnchanged(options: {
  root: string;
  existingWorker: ExistingCloudflareWorker | null;
  pinnedHandoffLink: CloudflareLink | null;
  initialCloudflareCandidate: CloudflareCandidateReceipt | null;
  accountId: string;
  workerName: string;
}): void {
  const { root, initialCloudflareCandidate: candidate } = options;
  if (options.existingWorker) {
    assertCloudflareLinkUnchanged(root, options.pinnedHandoffLink);
  }
  assertCloudflareCandidateUnchanged(root, candidate);
  if (
    candidate &&
    (candidate.accountId !== options.accountId || candidate.workerName !== options.workerName)
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different account or Worker. Inspect its receipt before retrying.',
    );
  }
}

/** Route activation through the pinned cf uploader, or the injected runner when there is no cf output. */
export function createCfActivationRunner(options: {
  cfOutput: CfBuildOutput | null;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  configPath: string;
  runWrangler: DeployWranglerRun;
  cfUploaderIsPinned: () => boolean;
  verifyCompatibilityRunner: () => boolean;
}): CloudflareCommandRunner | DeployWranglerRun {
  const { cfOutput, accountId, apiBaseUrl, configPath, runWrangler } = options;
  if (!cfOutput) {
    return runWrangler;
  }
  const runCf = createCfCommand({
    accountId,
    apiBaseUrl,
    env: deployChildEnv,
    verifyUploader: options.cfUploaderIsPinned,
  });
  return createCfVersionRunner({
    output: cfOutput,
    workerName: options.workerName,
    runCf,
    pinnedUpload: {
      accountId,
      apiBaseUrl,
      getToken: () => runWranglerAuthToken(runWrangler, configPath),
      verifyUploader: options.cfUploaderIsPinned,
    },
    verifyResources: createCfResourceVerifier({
      configPath,
      runCf,
      runWrangler,
      verifyCompatibilityRunner: options.verifyCompatibilityRunner,
    }),
  });
}

/** Activation callbacks that clear custom domains and crons when the config removes them. */
export function createCloudflareEmptyTriggerPublishers(options: {
  accountId: string;
  apiBaseUrl: string;
  configPath: string;
  workerName: string;
  runWrangler: DeployWranglerRun;
}): {
  publishEmptyCustomDomains: ReturnType<typeof createCloudflareEmptyDomainPublisher>;
  publishEmptyCrons: ReturnType<typeof createCloudflareEmptyCronPublisher>;
} {
  return {
    publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(options),
    publishEmptyCrons: createCloudflareEmptyCronPublisher(options),
  };
}

/** Persist the local state that follows a successful activation. */
export function recordCloudflareActivation(options: {
  root: string;
  configPath: string;
  accountId: string;
  workerName: string;
  existingWorker: ExistingCloudflareWorker | null;
  queueConsumerCleanup: ReturnType<typeof readWranglerManagedQueueCleanupCandidates>;
  execution: Extract<CloudflareActivationResult, { ok: true }>;
  cliLog: CliLogger;
}): void {
  const { root, configPath, execution } = options;
  clearCloudflareCandidate(root);
  if (options.existingWorker) {
    completeCloudflareLink(root);
  }
  acknowledgeWranglerManagedQueueRemovals(configPath, options.queueConsumerCleanup);
  rememberCloudflareWorkersDevSubdomain(root, options.accountId, execution.previewUrl);
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
  options.cliLog.info('cloudflare_deploy_end', {
    ok: true,
    worker: options.workerName,
    versionId: execution.versionId,
  });
}

export async function reportCloudflareActivationFailure(
  cliLog: CliLogger,
  message: string,
): Promise<void> {
  cliLog.error('cloudflare_deploy_failed', new Error(message));
  // The default exit() terminates the process immediately, so flush the diagnostic first.
  await cliLog.close().catch(() => {});
  log.error(`${message}${cliLog.path ? `\n\nDetailed log: ${cliLog.path}` : ''}`);
}

export async function activateCloudflareVersionWithProgress(
  activate: typeof activateCloudflareVersion,
  options: Parameters<typeof activateCloudflareVersion>[0],
): ReturnType<typeof activateCloudflareVersion> {
  const progress = createSpinner();
  progress.start('Checking the current Worker deployment...');
  try {
    const result = await activate({
      ...options,
      onProgress: (message) => progress.message(message),
    });
    if (result.ok) {
      progress.clear();
    } else {
      progress.error('Worker deployment stopped.');
    }
    return result;
  } catch (error) {
    progress.error('Worker deployment stopped.');
    throw error;
  }
}

export function formatCloudflareActivationError(
  result: Exclude<CloudflareActivationResult, { ok: true }>,
): string {
  const status = result.status === undefined ? '' : ` (exit ${String(result.status)})`;
  const cloudflareCode =
    result.cloudflareErrorCode === undefined
      ? ''
      : ` Cloudflare error code: ${String(result.cloudflareErrorCode)}.`;
  const diagnostic = result.diagnostic ? `\n\n${result.diagnostic}` : '';
  switch (result.reason) {
    case 'uploader-changed':
      if (result.rollback === 'succeeded') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Traffic was restored to the previous version.';
      }
      if (result.rollback === 'unavailable') {
        return 'deploy: the verified Wrangler uploader changed after the first version activated. No previous version is available; inspect `void project status` immediately.';
      }
      if (result.rollback === 'failed') {
        return 'deploy: the verified Wrangler uploader changed after version activation, and automatic traffic restoration failed. Inspect `void project status` immediately.';
      }
      if (result.rollback === 'unsafe') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Void did not invoke the changed binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
      }
      return 'deploy: the verified Wrangler uploader changed before version activation.';
    case 'status-failed':
      if (result.versionId) {
        return `deploy: Worker version ${result.versionId} was published, but current deployment status could not be verified${status}. Inspect \`void project status\` before retrying.`;
      }
      return `deploy: could not snapshot the current Cloudflare deployment${status}; no version was uploaded.`;
    case 'deployment-changed':
      return result.triggerRepair === 'succeeded'
        ? `deploy: another Cloudflare operation superseded this deployment. Void restored triggers for the active version ${result.activeVersionId ?? '(unknown)'}; retry from fresh deployment status.`
        : `deploy: another Cloudflare operation superseded this deployment, but its trigger state could not be verified. Inspect the active Worker version ${result.activeVersionId ?? '(unknown)'} immediately.`;
    case 'inheritance-source-unavailable':
      return 'deploy: could not verify which Worker Version would supply inherited secrets; production traffic is unchanged.';
    case 'inheritance-source-changed':
      return [
        'deploy: the active Worker Version is not the latest upload, and its secrets could not be pinned safely.',
        'Inspect the active and latest Worker versions in Cloudflare before retrying.',
        'No version was uploaded; production traffic is unchanged.',
      ].join('\n');
    case 'traffic-preservation-unavailable':
      return [
        'deploy: the existing Worker has dashboard-managed routes or visibility that Void cannot safely republish.',
        'Add its current routes, workers_dev, and preview_urls values to the root Wrangler config, then retry; no version was uploaded.',
      ].join('\n');
    case 'traffic-split-unsupported':
      return [
        'deploy: the current Cloudflare deployment splits traffic across multiple Worker Versions.',
        'Void will not flatten an existing gradual rollout to 100%. Finish or cancel that rollout',
        'in Cloudflare, then retry; no version was uploaded.',
      ].join('\n');
    case 'upload-failed':
      return `deploy: Cloudflare Worker Version upload failed${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}`;
    case 'upload-output-invalid':
      return 'deploy: Wrangler uploaded a version but did not report its version id; production traffic is unchanged.';
    case 'preview-unavailable':
      if (result.diagnostic) {
        return `deploy: candidate readiness cannot be verified.\n\n${result.diagnostic}`;
      }
      return [
        'deploy: the uploaded Worker Version has no preview URL, so Void cannot verify readiness.',
        'Set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain (for example "my-team")',
        'and retry. Void caches it after a successful workers.dev deployment; production traffic is unchanged.',
      ].join('\n');
    case 'readiness-staging-failed':
      return `deploy: Cloudflare could not stage the uploaded Worker Version at zero-percent traffic${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}${result.cloudflareErrorCode === 10210 && /Durable Object migration/i.test(result.diagnostic ?? '') ? '\n\nReview the Durable Object migration, then run `void deploy --platform cloudflare --atomic`. For future deploys, set deploy.cloudflare.mode to "atomic" in void.config.ts.' : ''}`;
    case 'atomic-failed':
      return `deploy: Cloudflare could not publish the Worker atomically${status}; inspect production status before retrying.${cloudflareCode}${diagnostic}`;
    case 'atomic-output-invalid':
      return 'deploy: Cloudflare published atomically but did not report a version id or URL. Inspect `void project status` immediately.';
    case 'atomic-readiness-failed':
    case 'atomic-readiness-access-denied':
      return `deploy: the atomic Worker deployment is live, but /__void/ready could not be verified. Inspect \`void project status\` and Worker logs immediately.${diagnostic}`;
    case 'readiness-failed':
      return [
        'deploy: the uploaded Worker Version did not pass /__void/ready.',
        formatCloudflareReadinessRestoration(result),
      ].join('\n');
    case 'readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the uploaded Worker Version readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token.',
        'For a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        `Then retry. ${formatCloudflareReadinessRestoration(result)}`,
      ].join('\n');
    case 'bootstrap-failed':
      return `deploy: Cloudflare could not bootstrap the first Worker deployment${status}.${cloudflareCode}${diagnostic}`;
    case 'bootstrap-output-invalid':
      return [
        'deploy: Cloudflare bootstrapped the first Worker deployment, but Wrangler',
        'did not report its version id and workers.dev URL. Inspect `void project status` before retrying.',
      ].join('\n');
    case 'bootstrap-readiness-failed':
      return (
        [
          'deploy: the first Worker deployment did not pass /__void/ready.',
          'Cloudflare requires this bootstrap to be non-versioned, so the new Worker is already active;',
          'inspect its logs and `void project status` before retrying.',
        ].join('\n') + diagnostic
      );
    case 'bootstrap-readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the first Worker deployment readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token;',
        'for a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        'Then retry. Cloudflare requires the first deployment to be non-versioned, so the new',
        'Worker is already active behind Access.',
      ].join('\n');
    case 'activation-failed':
      return `deploy: the ready Worker Version could not be activated${status}; production traffic is unchanged.`;
    case 'triggers-failed': {
      const rollback =
        result.rollback === 'succeeded'
          ? 'Traffic was restored to the previous version.'
          : result.rollback === 'unavailable'
            ? result.previousVersionId === null
              ? 'This was the first deployment, so no previous version was available to restore.'
              : 'Traffic or trigger restoration could not be completed. Inspect its routes, schedules, queues, and workflows in Cloudflare before retrying.'
            : 'Automatic traffic restoration failed; inspect `void project status` immediately.';
      return `deploy: the Worker activated, but Cloudflare trigger synchronization failed${status}. ${rollback}`;
    }
  }
}

function formatCloudflareReadinessRestoration(
  result: Exclude<CloudflareActivationResult, { ok: true }>,
): string {
  switch (result.rollback) {
    case 'succeeded':
      return 'The failed version remains inactive, and traffic was restored to the previous version.';
    case 'failed':
      return 'Automatic traffic restoration failed; inspect `void project status` immediately.';
    case 'unsafe':
      return 'Void did not invoke the changed Wrangler binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
    case 'unavailable':
      return 'No previous version was available to restore; inspect `void project status` immediately.';
    default:
      return 'The failed version remains inactive for inspection; production traffic is unchanged.';
  }
}

/** Capture the Access credential used only by the guarded Worker readiness probe. */
export function cloudflareWorkerReadinessHeaders(): Record<string, string> {
  return trustedCloudflareWorkerAccessHeaders({
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
    CF_ACCESS_TOKEN: process.env.CF_ACCESS_TOKEN,
  });
}
