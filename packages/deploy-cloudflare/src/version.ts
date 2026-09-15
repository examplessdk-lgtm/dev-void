import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { parseRootWranglerConfig } from './config.ts';
import type { CloudflareCommandResult, CloudflareCommandRunner } from './execute.ts';

const VERSION_ID_RE = /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i;
const PREVIEW_URL_RE = /Version Preview(?: Alias)? URL:\s*(https:\/\/\S+)/i;
const WORKERS_DEV_URL_RE = /(https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?)/i;
const CLOUDFLARE_ERROR_CODE_RE = /\[code:\s*(\d+)\]/i;
const DURABLE_MIGRATION_VERSION_ERROR = 10211;

export type CloudflareVersionMetadata =
  | Readonly<{
      schema: 1;
      migrations: ReadonlyArray<string>;
    }>
  | Readonly<{
      schema: 2;
      migrations: ReadonlyArray<string>;
      triggerConfig: CloudflareTriggerConfig;
    }>;

export type CloudflareTriggerConfig = Readonly<{
  workers_dev: boolean;
  preview_urls: boolean;
  routes: ReadonlyArray<unknown>;
  crons: ReadonlyArray<unknown>;
  queueConsumers: ReadonlyArray<unknown>;
  workflows: ReadonlyArray<unknown>;
  /**
   * Email Routing addresses (`addresses` in Wrangler config). Wrangler 4.131 applies its
   * Email Routing plan inside `triggers deploy` — `undefined` skips the plan entirely, while
   * `[]` is a destructive plan that deletes every rule this Worker owns — so the two must stay
   * distinct through the snapshot. Absent from annotations written before this field existed.
   */
  addresses?: ReadonlyArray<string>;
}>;

export type CloudflareTrafficConfig = Pick<
  CloudflareTriggerConfig,
  'workers_dev' | 'preview_urls' | 'routes'
>;

export type CloudflareVersionActivation =
  | {
      ok: true;
      versionId: string;
      previewUrl: string;
      previousVersionId: string | null;
      workersDevSubdomain?: string;
    }
  | {
      ok: false;
      reason:
        | 'uploader-changed'
        | 'status-failed'
        | 'deployment-changed'
        | 'traffic-split-unsupported'
        | 'upload-failed'
        | 'upload-output-invalid'
        | 'preview-unavailable'
        | 'readiness-staging-failed'
        | 'readiness-failed'
        | 'readiness-access-denied'
        | 'bootstrap-failed'
        | 'bootstrap-output-invalid'
        | 'bootstrap-readiness-failed'
        | 'bootstrap-readiness-access-denied'
        | 'activation-failed'
        | 'triggers-failed';
      status?: number;
      cloudflareErrorCode?: number;
      /** Wrangler reached Cloudflare's Containers entitlement endpoint and received a 403. */
      containersUnavailable?: boolean;
      versionId?: string;
      previousVersionId?: string | null;
      rollback?: 'not-needed' | 'succeeded' | 'failed' | 'unavailable' | 'unsafe';
      /** Version that owned production after a concurrent operation superseded this command. */
      activeVersionId?: string | null;
      /** Whether Void restored the active version's immutable trigger snapshot. */
      triggerRepair?: 'succeeded' | 'failed' | 'unavailable';
    };

type ProductionDeployment = Readonly<{
  versions?: ReadonlyArray<Readonly<{ version_id?: unknown; percentage?: unknown }>>;
}>;

/** Encode migration state into Cloudflare's version annotation for safe rollback diagnostics. */
export function encodeCloudflareVersionMessage(
  migrations: ReadonlyArray<string>,
  triggerConfig?: CloudflareTriggerConfig,
): string {
  const metadata: CloudflareVersionMetadata = triggerConfig
    ? { schema: 2, migrations, triggerConfig }
    : { schema: 1, migrations };
  return `void:${JSON.stringify(metadata)}`;
}

/** Read migration state written by {@link encodeCloudflareVersionMessage}. */
export function parseCloudflareVersionMessage(
  message: string | null | undefined,
): CloudflareVersionMetadata | null {
  if (!message?.startsWith('void:')) {
    return null;
  }
  try {
    const value = JSON.parse(message.slice(5)) as {
      schema?: unknown;
      migrations?: unknown;
      triggerConfig?: unknown;
    };
    if (
      (value.schema !== 1 && value.schema !== 2) ||
      !Array.isArray(value.migrations) ||
      !value.migrations.every((migration): migration is string => typeof migration === 'string')
    ) {
      return null;
    }
    if (value.schema === 1) {
      // Schema 1 did not capture preview_urls and represented an omitted
      // workers_dev ambiguously. Keep its migration history, but never expose
      // its incomplete trigger state to rollback.
      return { schema: 1, migrations: value.migrations };
    }
    const triggerConfig = parseTriggerConfig(value.triggerConfig);
    return triggerConfig ? { schema: 2, migrations: value.migrations, triggerConfig } : null;
  } catch {
    return null;
  }
}

/**
 * Capture every configuration surface mutated by `wrangler triggers deploy` — routes,
 * workers.dev / preview flags, crons, queue consumers, workflows, and Email Routing addresses.
 */
export function readCloudflareTriggerConfig(configPath: string): CloudflareTriggerConfig {
  return triggerConfigFromWrangler(parseRootWranglerConfig(configPath));
}

/** Apply a version's persisted trigger state using an isolated temporary Wrangler config. */
export async function deployCloudflareVersionTriggers(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  configPath?: string;
  triggerConfig: CloudflareTriggerConfig;
  /** Exact trigger state active before this transition, used to remove stale state. */
  previousTriggerConfig?: CloudflareTriggerConfig;
  /** Wrangler skips an empty Custom Domain set, so the caller may publish it directly. */
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  manageRoutes?: boolean;
}): Promise<CloudflareCommandResult> {
  const source = options.configPath ? parseRootWranglerConfig(options.configPath) : {};
  // `triggers deploy` still validates unrelated upload configuration. Build a trigger-only
  // config so an ephemeral assets directory (or another bundle-only field) cannot break the
  // post-activation reconciliation after `versions upload` has already consumed it.
  const base = pickWranglerTriggerContext(source);
  const config = triggerWranglerConfig(
    base,
    triggerConfigWithRemovedWorkflowSchedules(
      options.workerName,
      options.triggerConfig,
      options.previousTriggerConfig,
    ),
    options.manageRoutes,
  );
  const directory = mkdtempSync(join(tmpdir(), 'void-version-triggers-'));
  const configPath = join(directory, 'wrangler.json');
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const deployed = await options.runWrangler(
      ['triggers', 'deploy', '-c', configPath, '--env=', '--name', options.workerName],
      { capture: false },
    );
    if (!isCleanCommandExit(deployed)) {
      return deployed;
    }
    for (const queue of removedQueueConsumers(
      options.triggerConfig,
      options.previousTriggerConfig,
    )) {
      const removed = await options.runWrangler(
        ['queues', 'consumer', 'remove', queue, options.workerName, '-c', configPath, '--env='],
        { capture: false },
      );
      if (!isCleanCommandExit(removed)) {
        return removed;
      }
    }
    if (
      options.manageRoutes !== false &&
      hasCustomDomains(options.previousTriggerConfig?.routes) &&
      !hasCustomDomains(options.triggerConfig.routes)
    ) {
      if (!options.publishEmptyCustomDomains) {
        return {
          status: 1,
          stdout: '',
          stderr:
            'Wrangler cannot publish an empty Custom Domain set and no direct publisher was available.',
        };
      }
      const published = await options.publishEmptyCustomDomains();
      if (!isCleanCommandExit(published)) {
        return published;
      }
    }
    return deployed;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function pickWranglerTriggerContext(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['account_id', 'name', 'legacy_env', 'send_metrics', 'compliance_region']) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

export type CloudflareTriggerStabilization =
  | Readonly<{
      ok: true;
      activeVersionId: string;
      targetOwnsTraffic: boolean;
    }>
  | Readonly<{
      ok: false;
      reason: 'status-failed' | 'traffic-split' | 'metadata-unavailable' | 'triggers-failed';
      status?: number;
      activeVersionId?: string | null;
    }>;

/**
 * Reconcile triggers to the version that actually owns production traffic.
 *
 * Worker Version activation and `wrangler triggers deploy` are separate Cloudflare operations.
 * Another deploy or rollback can therefore take ownership between them. Re-read ownership before
 * and after every trigger publication and, when it changes, repair the new owner's immutable
 * schema-2 snapshot. The bounded loop fails closed if traffic never stabilizes.
 */
export async function stabilizeCloudflareVersionTriggers(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  configPath?: string;
  targetVersionId: string;
  targetTriggerConfig: CloudflareTriggerConfig;
  previousTriggerConfig?: CloudflareTriggerConfig;
  knownTriggerConfigs?: Readonly<Record<string, CloudflareTriggerConfig>>;
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  manageRoutes?: boolean;
  attempts?: number;
}): Promise<CloudflareTriggerStabilization> {
  const commonArgs = [...(options.configPath ? ['-c', options.configPath] : []), '--env='];
  let cleanupBaseline = mergeTriggerCleanupBaselines(
    options.previousTriggerConfig,
    options.targetTriggerConfig,
  );
  const attempts = Math.max(1, options.attempts ?? 4);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const owner = await readCurrentProductionVersion(options, commonArgs);
    if (owner.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: owner.status };
    }
    if (owner.kind === 'split') {
      return { ok: false, reason: 'traffic-split' };
    }
    if (!owner.versionId) {
      return { ok: false, reason: 'metadata-unavailable', activeVersionId: null };
    }

    const activeVersionId = owner.versionId;
    let activeTriggerConfig =
      activeVersionId === options.targetVersionId
        ? options.targetTriggerConfig
        : options.knownTriggerConfigs?.[activeVersionId];
    if (!activeTriggerConfig && activeVersionId !== options.targetVersionId) {
      const metadata = await readCloudflareVersionMetadata(options, commonArgs, activeVersionId);
      activeTriggerConfig = metadata?.schema === 2 ? metadata.triggerConfig : undefined;
    }
    if (!activeTriggerConfig) {
      return { ok: false, reason: 'metadata-unavailable', activeVersionId };
    }

    const triggers = await deployCloudflareVersionTriggers({
      runWrangler: options.runWrangler,
      workerName: options.workerName,
      configPath: options.configPath,
      triggerConfig: activeTriggerConfig,
      previousTriggerConfig: cleanupBaseline,
      publishEmptyCustomDomains: options.publishEmptyCustomDomains,
      manageRoutes: options.manageRoutes,
    });
    if (!isCleanCommandExit(triggers)) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        activeVersionId,
      };
    }

    cleanupBaseline = mergeTriggerCleanupBaselines(cleanupBaseline, activeTriggerConfig);
    const after = await readCurrentProductionVersion(options, commonArgs);
    if (after.kind === 'failed') {
      return { ok: false, reason: 'status-failed', status: after.status };
    }
    if (after.kind === 'split') {
      return { ok: false, reason: 'traffic-split' };
    }
    if (after.versionId === activeVersionId) {
      return {
        ok: true,
        activeVersionId,
        targetOwnsTraffic: activeVersionId === options.targetVersionId,
      };
    }
  }

  return { ok: false, reason: 'status-failed' };
}

function mergeTriggerCleanupBaselines(
  ...configs: Array<CloudflareTriggerConfig | undefined>
): CloudflareTriggerConfig {
  const present = configs.filter(
    (config): config is CloudflareTriggerConfig => config !== undefined,
  );
  const unique = (values: ReadonlyArray<unknown>): Array<unknown> => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  };
  // The baseline is only ever the `previousTriggerConfig` of `deployCloudflareVersionTriggers`,
  // which mines it for state the active version no longer wants (queue consumers, workflow
  // schedules, custom domains); it is never replayed as a version's own config. Email Routing
  // needs no such subtraction — Wrangler plans deletions from rule ownership, not from a previous
  // list — so `addresses` here is inert today. Carry it the same way as the other lists (the union
  // of every published plan) so the baseline stays a faithful record, and keep the key absent when
  // no version carried a plan: an absent key and `[]` are different plans.
  const withAddresses = present.filter((config) => config.addresses !== undefined);
  return {
    workers_dev: present.some((config) => config.workers_dev),
    preview_urls: present.some((config) => config.preview_urls),
    routes: unique(present.flatMap((config) => config.routes)),
    crons: unique(present.flatMap((config) => config.crons)),
    queueConsumers: unique(present.flatMap((config) => config.queueConsumers)),
    workflows: unique(present.flatMap((config) => config.workflows)),
    ...(withAddresses.length === 0
      ? {}
      : { addresses: [...new Set(withAddresses.flatMap((config) => config.addresses ?? []))] }),
  };
}

function removedQueueConsumers(
  desired: CloudflareTriggerConfig,
  previous: CloudflareTriggerConfig | undefined,
): Array<string> {
  if (!previous) {
    return [];
  }
  const desiredQueues = new Set(queueConsumerNames(desired.queueConsumers));
  return queueConsumerNames(previous.queueConsumers)
    .filter((queue) => !desiredQueues.has(queue))
    .sort();
}

function queueConsumerNames(consumers: ReadonlyArray<unknown>): Array<string> {
  return [
    ...new Set(
      consumers.flatMap((consumer) =>
        isRecord(consumer) && typeof consumer.queue === 'string' ? [consumer.queue] : [],
      ),
    ),
  ];
}

function triggerConfigWithQueueConsumerCleanup(
  previous: CloudflareTriggerConfig | undefined,
  cleanup: ReadonlyArray<string> | undefined,
): CloudflareTriggerConfig | undefined {
  const queues = [...new Set((cleanup ?? []).filter((queue) => queue.length > 0))];
  if (queues.length === 0) {
    return previous;
  }
  // This copy becomes the previous version's known trigger config, which
  // `stabilizeCloudflareVersionTriggers` replays verbatim when a concurrent rollback returns
  // traffic to that version. Spread `previous` so every snapshot field survives — including an
  // optional one such as `addresses`, where an absent key and `[]` are different Email Routing
  // plans — rather than re-listing fields and silently dropping a newer one.
  const base: CloudflareTriggerConfig = previous ?? {
    workers_dev: false,
    preview_urls: false,
    routes: [],
    crons: [],
    queueConsumers: [],
    workflows: [],
  };
  return {
    ...base,
    queueConsumers: [
      ...base.queueConsumers,
      ...queues
        .filter((queue) => !queueConsumerNames(base.queueConsumers).includes(queue))
        .map((queue) => ({ queue })),
    ],
  };
}

function triggerConfigWithRemovedWorkflowSchedules(
  workerName: string,
  desired: CloudflareTriggerConfig,
  previous: CloudflareTriggerConfig | undefined,
): CloudflareTriggerConfig {
  if (!previous) {
    return desired;
  }
  const desiredNames = new Set(
    desired.workflows.flatMap((workflow) =>
      isRecord(workflow) && typeof workflow.name === 'string' ? [workflow.name] : [],
    ),
  );
  const removed = previous.workflows.flatMap((workflow) => {
    if (
      !isRecord(workflow) ||
      typeof workflow.name !== 'string' ||
      typeof workflow.class_name !== 'string' ||
      desiredNames.has(workflow.name) ||
      (typeof workflow.script_name === 'string' && workflow.script_name !== workerName)
    ) {
      return [];
    }
    return [{ ...workflow, schedules: [] }];
  });
  return removed.length === 0
    ? desired
    : { ...desired, workflows: [...desired.workflows, ...removed] };
}

function hasCustomDomains(routes: ReadonlyArray<unknown> | undefined): boolean {
  return routes?.some((route) => isRecord(route) && route.custom_domain === true) === true;
}

/** Select a configured HTTPS route that is guaranteed to cover /__void/ready. */
function customRouteReadinessUrl(routes: ReadonlyArray<unknown>): string | undefined {
  for (const route of routes) {
    const pattern =
      typeof route === 'string'
        ? route
        : isRecord(route) && typeof route.pattern === 'string'
          ? route.pattern
          : undefined;
    if (!pattern) {
      continue;
    }
    const customDomain = isRecord(route) && route.custom_domain === true;
    const withoutScheme = pattern.replace(/^https?:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    const hostname = (slash < 0 ? withoutScheme : withoutScheme.slice(0, slash)).trim();
    const path = slash < 0 ? '' : withoutScheme.slice(slash);
    if (!hostname || hostname.includes('*') || (!customDomain && path !== '/*' && path !== '*')) {
      continue;
    }
    return `https://${hostname}`;
  }
  return undefined;
}

function triggerConfigFromWrangler(config: Record<string, unknown>): CloudflareTriggerConfig {
  const triggers = isRecord(config.triggers) ? config.triggers : {};
  const queues = isRecord(config.queues) ? config.queues : {};
  const routes = Array.isArray(config.routes)
    ? config.routes
    : config.route === undefined
      ? []
      : [config.route];
  // Wrangler disables workers.dev by default when an explicit route is
  // configured. Persist the effective value so trigger publication and
  // rollback do not accidentally reopen the public workers.dev hostname.
  const workersDev =
    typeof config.workers_dev === 'boolean' ? config.workers_dev : routes.length === 0;
  const addresses = readEmailAddresses(config.addresses);
  return {
    workers_dev: workersDev,
    preview_urls: typeof config.preview_urls === 'boolean' ? config.preview_urls : workersDev,
    routes,
    crons: Array.isArray(triggers.crons) ? triggers.crons : [],
    queueConsumers: Array.isArray(queues.consumers) ? queues.consumers : [],
    workflows: Array.isArray(config.workflows) ? config.workflows : [],
    ...(addresses === undefined ? {} : { addresses }),
  };
}

/** A well-formed `addresses` array, or `undefined` when the field is absent or malformed. */
function readEmailAddresses(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as ReadonlyArray<string>)
    : undefined;
}

function parseTriggerConfig(value: unknown): CloudflareTriggerConfig | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.workers_dev !== 'boolean' ||
    typeof value.preview_urls !== 'boolean' ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.crons) ||
    !Array.isArray(value.queueConsumers) ||
    !Array.isArray(value.workflows) ||
    (value.addresses !== undefined && readEmailAddresses(value.addresses) === undefined)
  ) {
    return null;
  }
  return {
    workers_dev: value.workers_dev,
    preview_urls: value.preview_urls,
    routes: value.routes,
    crons: value.crons,
    queueConsumers: value.queueConsumers,
    workflows: value.workflows,
    ...(value.addresses === undefined ? {} : { addresses: value.addresses as Array<string> }),
  };
}

function triggerWranglerConfig(
  base: Record<string, unknown>,
  triggerConfig: CloudflareTriggerConfig,
  manageRoutes = true,
): Record<string, unknown> {
  const triggers = isRecord(base.triggers) ? { ...base.triggers } : {};
  const queues = isRecord(base.queues) ? { ...base.queues } : {};
  triggers.crons = [...triggerConfig.crons];
  queues.consumers = [...triggerConfig.queueConsumers];
  const config: Record<string, unknown> = {
    ...base,
    triggers,
    queues,
    workflows: [...triggerConfig.workflows],
    workers_dev: triggerConfig.workers_dev,
    preview_urls: triggerConfig.preview_urls,
  };
  if (manageRoutes) {
    config.routes = [...triggerConfig.routes];
  }
  // Only a snapshot that carried `addresses` may reach Wrangler's Email Routing plan: an
  // absent key skips the plan, which is what a version deployed without email must do.
  // That holds in both directions of a rollback — the snapshot being LEFT lends nothing
  // here — so rolling back from an email-enabled version to one recorded without the key
  // (a pre-`addresses` snapshot, or a deploy that had no handlers) leaves the rules where
  // they are, routed to a Worker that no longer exports `email()`. Do not encode that
  // transition as `[]`: wrangler plans the deletion of every rule this Worker owns on `[]`,
  // a destructive plan it confirms (default No) in a TTY and refuses in CI, and a
  // non-zero `triggers deploy` here is `triggers-failed`, which the rollback compensates
  // by restoring the version it just left. Whether a rollback should touch Email Routing
  // at all is a product call (design doc 0078, decision 13); this code replays the
  // snapshot verbatim.
  if (triggerConfig.addresses !== undefined) {
    config.addresses = [...triggerConfig.addresses];
  }
  delete config.route;
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upload, probe, and atomically activate a verified Worker Version. */
export async function activateCloudflareVersion(options: {
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  workerName: string;
  configPath?: string;
  /** Override only the asset directory for this upload, leaving the persisted config intact. */
  assetsDirectoryOverride?: string;
  /** Optional Cloudflare Access headers used only by the readiness probe. */
  readinessHeaders?: Readonly<Record<string, string>>;
  /** Account workers.dev subdomain used when this Worker cannot expose version preview URLs. */
  workersDevSubdomain?: string;
  /**
   * Operator-provided workers.dev subdomain that may receive readiness credentials even when
   * Wrangler cannot report a preview URL. Cached/project-controlled values must not be used here.
   */
  readinessHeadersWorkersDevSubdomain?: string;
  message: string;
  /** Direct empty-domain publisher for the Wrangler reconciliation gap. */
  publishEmptyCustomDomains?: () => Promise<CloudflareCommandResult>;
  /** Last successfully published traffic state, newer than immutable version annotations. */
  previousTrafficConfig?: CloudflareTrafficConfig;
  /** Explicitly Void-owned queue consumers retained for schema-1 cleanup and failed retries. */
  queueConsumerCleanup?: ReadonlyArray<string>;
  /**
   * The caller proved that the Worker did not exist before this deploy provisioned its secrets.
   * Wrangler creates an active placeholder version when attaching the first secret, so the status
   * read below can legitimately observe a version even though no application was ever deployed.
   */
  allowFirstDeploymentBootstrap?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessAttempts?: number;
}): Promise<CloudflareVersionActivation> {
  const configArgs = options.configPath ? ['-c', options.configPath] : [];
  const commonArgs = [...configArgs, '--env='];
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const previous = await readCurrentProductionVersion(options, commonArgs);
  if (previous.kind === 'failed') {
    return { ok: false, reason: 'status-failed', status: previous.status };
  }
  if (previous.kind === 'split') {
    return { ok: false, reason: 'traffic-split-unsupported' };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const desiredMetadata = parseCloudflareVersionMessage(options.message);
  const desiredTriggerConfig =
    desiredMetadata?.schema === 2
      ? desiredMetadata.triggerConfig
      : options.configPath
        ? readCloudflareTriggerConfig(options.configPath)
        : triggerConfigFromWrangler({});
  const previousMetadata =
    previous.versionId && desiredMetadata?.schema === 2
      ? await readCloudflareVersionMetadata(options, commonArgs, previous.versionId)
      : null;
  const versionedPreviousTriggerConfig =
    previousMetadata?.schema === 2 ? previousMetadata.triggerConfig : undefined;
  const versionedPreviousTriggerConfigWithTraffic =
    versionedPreviousTriggerConfig && options.previousTrafficConfig
      ? { ...versionedPreviousTriggerConfig, ...options.previousTrafficConfig }
      : versionedPreviousTriggerConfig;
  const previousTriggerConfig = triggerConfigWithQueueConsumerCleanup(
    versionedPreviousTriggerConfigWithTraffic,
    options.queueConsumerCleanup,
  );

  const alias = `void-ready-${Date.now().toString(36)}`;
  const upload = await Promise.resolve(
    options.runWrangler(
      [
        'versions',
        'upload',
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        options.message,
        ...(options.assetsDirectoryOverride ? ['--assets', options.assetsDirectoryOverride] : []),
        '--preview-alias',
        alias,
        '--strict',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
      ],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(upload)) {
    const output = `${upload.stdout}\n${upload.stderr}`;
    const cloudflareErrorCode = parseCloudflareErrorCode(output);
    if (
      (previous.versionId === null || options.allowFirstDeploymentBootstrap === true) &&
      (cloudflareErrorCode === DURABLE_MIGRATION_VERSION_ERROR ||
        /cannot upload a new version of a worker that does not yet exist/i.test(output))
    ) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    return {
      ok: false,
      reason: 'upload-failed',
      status: upload.status,
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(output) ? { containersUnavailable: true } : {}),
    };
  }

  const output = `${upload.stdout}\n${upload.stderr}`;
  const versionId = output.match(VERSION_ID_RE)?.[1];
  if (!versionId) {
    return { ok: false, reason: 'upload-output-invalid' };
  }
  const reportedPreviewUrl = output.match(PREVIEW_URL_RE)?.[1];
  let authenticatedWorkersDevSubdomain = reportedPreviewUrl
    ? extractWorkersDevSubdomain(reportedPreviewUrl)
    : undefined;
  let readinessUrl = reportedPreviewUrl;
  let readinessUsesCustomRoute = false;
  let stagedVersionOverride = false;
  if (!readinessUrl) {
    if (previous.versionId === null || options.allowFirstDeploymentBootstrap === true) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    readinessUrl = desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(options.workerName, options.workersDevSubdomain)
      : customRouteReadinessUrl(desiredTriggerConfig.routes);
    readinessUsesCustomRoute = !desiredTriggerConfig.workers_dev && readinessUrl !== undefined;
    if (!readinessUrl) {
      return {
        ok: false,
        reason: 'preview-unavailable',
        versionId,
        previousVersionId: previous.versionId,
      };
    }
    const fallbackSubdomain = extractWorkersDevSubdomain(readinessUrl);
    if (fallbackSubdomain && fallbackSubdomain === options.readinessHeadersWorkersDevSubdomain) {
      authenticatedWorkersDevSubdomain = fallbackSubdomain;
    }
    if (!options.verifyUploader()) {
      return {
        ok: false,
        reason: 'uploader-changed',
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    const staged = await deployVersionPercentages(
      options,
      commonArgs,
      [`${previous.versionId}@100`, `${versionId}@0`],
      options.message,
    );
    if (!isCleanCommandExit(staged)) {
      return {
        ok: false,
        reason: 'readiness-staging-failed',
        status: staged.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    stagedVersionOverride = true;
  }

  let ready = await probeReadiness(
    `${readinessUrl.replace(/\/$/, '')}/__void/ready`,
    options.workerName,
    readinessUsesCustomRoute ? undefined : options.readinessHeaders,
    authenticatedWorkersDevSubdomain,
    stagedVersionOverride ? versionId : undefined,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );

  // Account-wide Access default-deny commonly blocks Wrangler's generated preview alias even
  // when the stable `<worker>.<account>.workers.dev` destination has an application admitting the
  // operator or a service token. The preview response gives us the account subdomain, so preserve
  // the same no-traffic readiness invariant by staging the uploaded version at 0% and selecting it
  // explicitly through the stable, policy-covered hostname. This requires a prior active version
  // whose traffic can remain untouched while the new version is staged; a truly empty first
  // deployment has no safe zero-percent fallback.
  if (ready === 'access-denied' && !stagedVersionOverride && previous.versionId !== null) {
    const stableReadinessUrl = desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(
          options.workerName,
          extractWorkersDevSubdomain(readinessUrl) ?? options.workersDevSubdomain,
        )
      : customRouteReadinessUrl(desiredTriggerConfig.routes);
    if (stableReadinessUrl && stableReadinessUrl !== readinessUrl) {
      if (!options.verifyUploader()) {
        return {
          ok: false,
          reason: 'uploader-changed',
          versionId,
          previousVersionId: previous.versionId,
          rollback: 'not-needed',
        };
      }
      const staged = await deployVersionPercentages(
        options,
        commonArgs,
        [`${previous.versionId}@100`, `${versionId}@0`],
        options.message,
      );
      if (!isCleanCommandExit(staged)) {
        return {
          ok: false,
          reason: 'readiness-staging-failed',
          status: staged.status,
          versionId,
          previousVersionId: previous.versionId,
          rollback: 'not-needed',
        };
      }
      readinessUrl = stableReadinessUrl;
      authenticatedWorkersDevSubdomain = extractWorkersDevSubdomain(stableReadinessUrl);
      readinessUsesCustomRoute = !desiredTriggerConfig.workers_dev;
      stagedVersionOverride = true;
      ready = await probeReadiness(
        `${readinessUrl.replace(/\/$/, '')}/__void/ready`,
        options.workerName,
        readinessUsesCustomRoute ? undefined : options.readinessHeaders,
        authenticatedWorkersDevSubdomain,
        versionId,
        options.fetch ?? globalThis.fetch,
        options.sleep ?? defaultSleep,
        options.readinessAttempts ?? 6,
      );
    }
  }
  if (ready !== 'ready') {
    return {
      ok: false,
      reason: ready === 'access-denied' ? 'readiness-access-denied' : 'readiness-failed',
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(options, commonArgs, previous.versionId, 'readiness failed')
        : 'not-needed',
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'uploader verification failed',
          )
        : 'not-needed',
    };
  }

  // Readiness can take long enough for another deploy or rollback to finish. Never flatten that
  // newer operation using the stale `previous` snapshot captured before this upload began.
  const ownerBeforeActivation = await readCurrentProductionVersion(options, commonArgs);
  if (ownerBeforeActivation.kind === 'failed') {
    return {
      ok: false,
      reason: 'status-failed',
      status: ownerBeforeActivation.status,
      versionId,
      previousVersionId: previous.versionId,
    };
  }
  if (ownerBeforeActivation.kind === 'split') {
    return {
      ok: false,
      reason: 'traffic-split-unsupported',
      versionId,
      previousVersionId: previous.versionId,
    };
  }
  if (ownerBeforeActivation.versionId !== previous.versionId) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId: previous.versionId,
      activeVersionId: ownerBeforeActivation.versionId,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    };
  }

  const activate = await deployVersionPercentages(
    options,
    commonArgs,
    [`${versionId}@100`],
    options.message,
  );
  if (!isCleanCommandExit(activate)) {
    return {
      ok: false,
      reason: 'activation-failed',
      status: activate.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'version activation failed',
          )
        : 'not-needed',
    };
  }

  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      // Never invoke a binary that just failed integrity verification, even to
      // restore traffic. The active version must be repaired with a trusted
      // Wrangler installation instead.
      rollback: previous.versionId ? 'unsafe' : 'unavailable',
    };
  }
  const knownTriggerConfigs: Record<string, CloudflareTriggerConfig> = {
    [versionId]: desiredTriggerConfig,
  };
  if (previous.versionId && previousTriggerConfig) {
    knownTriggerConfigs[previous.versionId] = previousTriggerConfig;
  }
  const triggers = await stabilizeCloudflareVersionTriggers({
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    targetVersionId: versionId,
    targetTriggerConfig: desiredTriggerConfig,
    previousTriggerConfig,
    knownTriggerConfigs,
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
  });
  if (!triggers.ok) {
    if (triggers.activeVersionId && triggers.activeVersionId !== versionId) {
      return {
        ok: false,
        reason: 'deployment-changed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: triggers.activeVersionId,
        rollback: 'not-needed',
        triggerRepair: triggers.reason === 'metadata-unavailable' ? 'unavailable' : 'failed',
      };
    }
    if (!triggers.activeVersionId) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'unsafe',
      };
    }
    const ownerBeforeCompensation = await readCurrentProductionVersion(options, commonArgs);
    if (ownerBeforeCompensation.kind !== 'ok' || ownerBeforeCompensation.versionId === null) {
      return {
        ok: false,
        reason: 'triggers-failed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'unsafe',
      };
    }
    if (ownerBeforeCompensation.versionId !== versionId) {
      const repair = await stabilizeCloudflareVersionTriggers({
        runWrangler: options.runWrangler,
        workerName: options.workerName,
        configPath: options.configPath,
        targetVersionId: versionId,
        targetTriggerConfig: desiredTriggerConfig,
        previousTriggerConfig,
        knownTriggerConfigs,
        publishEmptyCustomDomains: options.publishEmptyCustomDomains,
      });
      return {
        ok: false,
        reason: 'deployment-changed',
        status: triggers.status,
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: repair.activeVersionId ?? ownerBeforeCompensation.versionId,
        rollback: 'not-needed',
        triggerRepair: repair.ok
          ? 'succeeded'
          : repair.reason === 'metadata-unavailable'
            ? 'unavailable'
            : 'failed',
      };
    }
    const rollback = await restorePreviousVersionAndTriggers(
      options,
      commonArgs,
      previous.versionId,
      'trigger activation failed',
      desiredTriggerConfig,
    );
    return {
      ok: false,
      reason: 'triggers-failed',
      status: triggers.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback,
    };
  }

  if (!triggers.targetOwnsTraffic) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId: previous.versionId,
      activeVersionId: triggers.activeVersionId,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    };
  }

  return {
    ok: true,
    versionId,
    previewUrl: publishedCloudflareUrl(options.workerName, desiredTriggerConfig, readinessUrl),
    previousVersionId: previous.versionId,
    ...workersDevSubdomainResult(readinessUrl),
  };
}

async function restorePreviousVersionAndTriggers(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'verifyUploader' | 'workerName' | 'publishEmptyCustomDomains'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  cause: string,
  failedTriggerConfig: CloudflareTriggerConfig,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  const traffic = await restorePreviousVersion(options, commonArgs, previousVersionId, cause);
  if (traffic !== 'succeeded' || !previousVersionId) {
    return traffic;
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const metadata = await readCloudflareVersionMetadata(options, commonArgs, previousVersionId);
  if (metadata?.schema !== 2) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const triggers = await stabilizeCloudflareVersionTriggers({
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    targetVersionId: previousVersionId,
    targetTriggerConfig: metadata.triggerConfig,
    previousTriggerConfig: failedTriggerConfig,
    knownTriggerConfigs: { [previousVersionId]: metadata.triggerConfig },
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
  });
  return triggers.ok && triggers.targetOwnsTraffic ? 'succeeded' : 'failed';
}

async function readCloudflareVersionMetadata(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  versionId: string,
): Promise<CloudflareVersionMetadata | null> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['versions', 'list', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    return null;
  }
  try {
    const versions = JSON.parse(result.stdout) as Array<unknown>;
    if (!Array.isArray(versions)) {
      return null;
    }
    for (const entry of versions) {
      if (!isRecord(entry) || entry.id !== versionId || !isRecord(entry.annotations)) {
        continue;
      }
      const message = entry.annotations['workers/message'];
      return typeof message === 'string' ? parseCloudflareVersionMessage(message) : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The Versions API cannot create a Worker or its initial Durable Object migration history, and
 * some accounts do not expose a version preview until their first ordinary deployment. A
 * brand-new Worker can therefore need one ordinary deploy before later releases use preview-first
 * version activation. This fallback requires prior proof that no application had been deployed.
 */
async function bootstrapFirstDeployment(
  options: Parameters<typeof activateCloudflareVersion>[0],
  commonArgs: Array<string>,
  previousVersionId: string | null,
): Promise<CloudflareVersionActivation> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const bootstrap = await Promise.resolve(
    options.runWrangler(
      [
        'deploy',
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        options.message,
        ...(options.assetsDirectoryOverride ? ['--assets', options.assetsDirectoryOverride] : []),
        '--strict',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: true },
    ),
  );
  const output = `${bootstrap.stdout}\n${bootstrap.stderr}`;
  if (!isCleanCommandExit(bootstrap)) {
    const cloudflareErrorCode = parseCloudflareErrorCode(output);
    return {
      ok: false,
      reason: 'bootstrap-failed',
      status: bootstrap.status,
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(output) ? { containersUnavailable: true } : {}),
    };
  }
  const versionId = output.match(VERSION_ID_RE)?.[1];
  const desiredMetadata = parseCloudflareVersionMessage(options.message);
  const desiredTriggerConfig =
    desiredMetadata?.schema === 2
      ? desiredMetadata.triggerConfig
      : options.configPath
        ? readCloudflareTriggerConfig(options.configPath)
        : triggerConfigFromWrangler({});
  const reportedUrl = output.match(PREVIEW_URL_RE)?.[1] ?? output.match(WORKERS_DEV_URL_RE)?.[1];
  const reportedOrConfiguredUrl =
    reportedUrl ??
    (desiredTriggerConfig.workers_dev
      ? workersDevReadinessUrl(options.workerName, options.workersDevSubdomain)
      : customRouteReadinessUrl(desiredTriggerConfig.routes));
  if (!versionId || !reportedOrConfiguredUrl) {
    return {
      ok: false,
      reason: 'bootstrap-output-invalid',
      previousVersionId,
      ...(versionId ? { versionId } : {}),
    };
  }
  const previewUrl = publishedCloudflareUrl(
    options.workerName,
    desiredTriggerConfig,
    reportedOrConfiguredUrl,
  );
  const ready = await probeReadiness(
    `${previewUrl.replace(/\/$/, '')}/__void/ready`,
    options.workerName,
    reportedUrl || desiredTriggerConfig.workers_dev ? options.readinessHeaders : undefined,
    extractWorkersDevSubdomain(previewUrl),
    undefined,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );
  if (ready !== 'ready') {
    return {
      ok: false,
      reason:
        ready === 'access-denied'
          ? 'bootstrap-readiness-access-denied'
          : 'bootstrap-readiness-failed',
      versionId,
      previousVersionId,
      rollback: 'unavailable',
    };
  }
  return {
    ok: true,
    versionId,
    previewUrl,
    previousVersionId,
    ...workersDevSubdomainResult(previewUrl),
  };
}

function parseCloudflareErrorCode(output: string): number | undefined {
  const value = output.match(CLOUDFLARE_ERROR_CODE_RE)?.[1];
  return value === undefined ? undefined : Number(value);
}

/** Recognize the Containers account-entitlement failure Wrangler exposes during upload. */
function isContainersUnavailable(output: string): boolean {
  return (
    (/\/containers\/me(?:\b|\?)/i.test(output) && /\b403\b/.test(output)) ||
    /Cloudflare Containers[^\n]*(?:Workers Paid|not (?:enabled|available)|subscription)/i.test(
      output,
    )
  );
}

async function readCurrentProductionVersion(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
): Promise<
  { kind: 'ok'; versionId: string | null } | { kind: 'failed'; status: number } | { kind: 'split' }
> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['deployments', 'status', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      parseCloudflareErrorCode(output) === 10007 ||
      /no deployments|\bworker\b.*\b(?:does not exist|not found)\b/i.test(output)
    ) {
      return { kind: 'ok', versionId: null };
    }
    return { kind: 'failed', status: result.status };
  }
  try {
    const deployment = JSON.parse(result.stdout) as ProductionDeployment;
    const versions = (deployment.versions ?? []).filter(
      (version) => Number(version.percentage) > 0,
    );
    if (versions.length > 1 || (versions.length === 1 && Number(versions[0]?.percentage) !== 100)) {
      return { kind: 'split' };
    }
    const active = versions[0];
    return {
      kind: 'ok',
      versionId: typeof active?.version_id === 'string' ? active.version_id : null,
    };
  } catch {
    return { kind: 'failed', status: result.status };
  }
}

async function probeReadiness(
  url: string,
  workerName: string,
  readinessHeaders: Readonly<Record<string, string>> | undefined,
  authenticatedWorkersDevSubdomain: string | undefined,
  versionOverride: string | undefined,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<'ready' | 'failed' | 'access-denied'> {
  const headers = guardedReadinessHeaders(
    url,
    workerName,
    readinessHeaders,
    authenticatedWorkersDevSubdomain,
  );
  if (headers === null) {
    return 'failed';
  }
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      const response = await fetcher(url, {
        headers: {
          'user-agent': 'void-deploy-readiness/1',
          ...headers,
          ...(versionOverride
            ? {
                'Cloudflare-Workers-Version-Overrides': `${workerName}="${versionOverride}"`,
              }
            : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { ready?: unknown };
        if (body.ready === true) {
          return 'ready';
        }
      } else if (await isCloudflareAccessDenial(response)) {
        return 'access-denied';
      }
    } catch {
      // Preview propagation is eventually consistent; retry below.
    }
    if (attempt + 1 < attempts) {
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  return 'failed';
}

/** Never forward Access headers to a hostname that cannot be this Worker. */
function guardedReadinessHeaders(
  url: string,
  workerName: string,
  headers: Readonly<Record<string, string>> | undefined,
  authenticatedWorkersDevSubdomain: string | undefined,
): Readonly<Record<string, string>> | null {
  if (!headers || Object.keys(headers).length === 0) {
    return {};
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const firstLabel = hostname.split('.')[0] ?? '';
    const normalizedWorkerName = workerName.toLowerCase();
    const subdomain = extractWorkersDevSubdomain(url);
    if (
      parsed.protocol !== 'https:' ||
      !subdomain ||
      subdomain !== authenticatedWorkersDevSubdomain ||
      (firstLabel !== normalizedWorkerName && !firstLabel.endsWith(`-${normalizedWorkerName}`))
    ) {
      return null;
    }
    return headers;
  } catch {
    return null;
  }
}

async function isCloudflareAccessDenial(response: Response): Promise<boolean> {
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get('location')?.includes('/cdn-cgi/access/')
  ) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    return true;
  }
  try {
    return /(?:error\s+code:\s*)?1050\b/i.test(await response.text());
  } catch {
    return false;
  }
}

async function deployVersionPercentages(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  percentages: Array<string>,
  message: string,
): Promise<CloudflareCommandResult> {
  return options.runWrangler(
    [
      'versions',
      'deploy',
      ...percentages,
      ...commonArgs,
      '--name',
      options.workerName,
      '--message',
      message,
      '--yes',
    ],
    { capture: false },
  );
}

async function restorePreviousVersion(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  cause: string,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  if (!previousVersionId) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const result = await deployVersionPercentages(
    options,
    commonArgs,
    [`${previousVersionId}@100`],
    `Void automatic rollback after ${cause}.`,
  );
  return isCleanCommandExit(result) ? 'succeeded' : 'failed';
}

function workersDevReadinessUrl(workerName: string, value: string | undefined): string | undefined {
  const subdomain = normalizeWorkersDevSubdomain(value);
  if (!subdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    return undefined;
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/** Resolve the stable URL that owns production traffic after triggers are published. */
function publishedCloudflareUrl(
  workerName: string,
  triggerConfig: CloudflareTriggerConfig,
  fallbackUrl: string,
): string {
  if (triggerConfig.workers_dev) {
    return (
      workersDevReadinessUrl(workerName, extractWorkersDevSubdomain(fallbackUrl)) ?? fallbackUrl
    );
  }
  return customRouteReadinessUrl(triggerConfig.routes) ?? fallbackUrl;
}

/** Normalize an account workers.dev subdomain supplied by config or the environment. */
export function normalizeWorkersDevSubdomain(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/\.workers\.dev\/?$/, '');
  if (!normalized || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.fed)?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/** Extract the account subdomain from a Wrangler-reported workers.dev URL. */
export function extractWorkersDevSubdomain(url: string): string | undefined {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.');
    if (labels.at(-2) !== 'workers' || labels.at(-1) !== 'dev') {
      return undefined;
    }
    if (labels.length === 4) {
      return normalizeWorkersDevSubdomain(labels[1]);
    }
    if (labels.length === 5 && labels[2] === 'fed') {
      return normalizeWorkersDevSubdomain(`${labels[1]}.fed`);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function workersDevSubdomainResult(url: string): { workersDevSubdomain?: string } {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  return workersDevSubdomain ? { workersDevSubdomain } : {};
}

function isCleanCommandExit(result: CloudflareCommandResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
