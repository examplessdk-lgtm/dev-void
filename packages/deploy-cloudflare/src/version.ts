import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { join } from 'pathslash';
import { parseRootWranglerConfig } from './config.ts';
import { cloudflareCommandDiagnostic } from './diagnostics.ts';
import type { CloudflareCommandResult, CloudflareCommandRunner } from './execute.ts';
import { isWranglerSecretOnlyDraft } from './secret-draft.ts';

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
  /** This version retained the existing triggers instead of publishing a snapshot. */
  preserve?: boolean;
  preserveRoutes?: boolean;
  preserveWorkersDev?: boolean;
  preservePreviewUrls?: boolean;
  /** Fingerprint of explicit non-versioned settings while remote triggers stay opaque. */
  settingsHash?: string;
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
      preservedTriggers?: boolean;
      trafficConfig?: CloudflareTrafficConfig;
    }
  | {
      ok: false;
      reason:
        | 'uploader-changed'
        | 'status-failed'
        | 'deployment-changed'
        | 'inheritance-source-unavailable'
        | 'inheritance-source-changed'
        | 'traffic-preservation-unavailable'
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
      /** Bounded uploader error text with terminal escapes removed and common credential formats redacted. */
      diagnostic?: string;
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

type ProductionVersionPercentage = Readonly<{ versionId: string; percentage: number }>;

type CurrentProductionVersion =
  | {
      kind: 'ok';
      versionId: string | null;
      versions: ReadonlyArray<ProductionVersionPercentage>;
    }
  | { kind: 'failed'; status: number }
  | { kind: 'split' };

type RecentCloudflareVersion = Readonly<{
  id: string;
  number: number;
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
export function readCloudflareTriggerConfig(
  configPath: string,
  sourceConfigPath?: string,
): CloudflareTriggerConfig {
  const result = triggerConfigFromWrangler(parseRootWranglerConfig(configPath));
  if (!sourceConfigPath) {
    return result;
  }
  const source = parseRootWranglerConfig(sourceConfigPath);
  return {
    ...result,
    settingsHash: nonVersionedSettingsHash(source),
    ...(source.route === undefined && source.routes === undefined ? { preserveRoutes: true } : {}),
    ...(source.workers_dev === undefined ? { preserveWorkersDev: true } : {}),
    ...(source.preview_urls === undefined ? { preservePreviewUrls: true } : {}),
  };
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
  if (options.triggerConfig.preserve) {
    return { status: 0, stdout: '', stderr: '' };
  }
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
      !options.triggerConfig.preserveRoutes &&
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
    ...(config.routes === undefined && config.route === undefined ? { preserveRoutes: true } : {}),
    ...(config.workers_dev === undefined ? { preserveWorkersDev: true } : {}),
    ...(config.preview_urls === undefined ? { preservePreviewUrls: true } : {}),
    settingsHash: nonVersionedSettingsHash(config),
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

function nonVersionedSettingsHash(config: Record<string, unknown>): string {
  const settings = Object.fromEntries(
    ['logpush', 'observability', 'tail_consumers', 'streaming_tail_consumers']
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
  return createHash('sha256').update(stableJson(settings)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseTriggerConfig(value: unknown): CloudflareTriggerConfig | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    ['preserve', 'preserveRoutes', 'preserveWorkersDev', 'preservePreviewUrls'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    ) ||
    (value.settingsHash !== undefined && typeof value.settingsHash !== 'string') ||
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
    ...(value.preserve === true ? { preserve: true } : {}),
    ...(value.preserveRoutes === true ? { preserveRoutes: true } : {}),
    ...(value.preserveWorkersDev === true ? { preserveWorkersDev: true } : {}),
    ...(value.preservePreviewUrls === true ? { preservePreviewUrls: true } : {}),
    ...(typeof value.settingsHash === 'string' ? { settingsHash: value.settingsHash } : {}),
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
  if (manageRoutes && !triggerConfig.preserveRoutes) {
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
  if (triggerConfig.preserveWorkersDev) {
    delete config.workers_dev;
  }
  if (triggerConfig.preservePreviewUrls) {
    delete config.preview_urls;
  }
  delete config.route;
  return config;
}

function resolvePreservedTraffic(
  desired: CloudflareTriggerConfig,
  previous: CloudflareTrafficConfig | undefined,
  workerExists: boolean,
): CloudflareTriggerConfig | null {
  const preservesTraffic =
    desired.preserveRoutes || desired.preserveWorkersDev || desired.preservePreviewUrls;
  if (preservesTraffic && workerExists && !previous) {
    return null;
  }
  return {
    ...(desired.preserve ? { preserve: true } : {}),
    ...(desired.settingsHash ? { settingsHash: desired.settingsHash } : {}),
    workers_dev: desired.preserveWorkersDev
      ? (previous?.workers_dev ?? desired.workers_dev)
      : desired.workers_dev,
    preview_urls: desired.preservePreviewUrls
      ? (previous?.preview_urls ?? desired.preview_urls)
      : desired.preview_urls,
    routes: desired.preserveRoutes ? (previous?.routes ?? desired.routes) : desired.routes,
    crons: desired.crons,
    queueConsumers: desired.queueConsumers,
    workflows: desired.workflows,
    // Not a traffic surface, but this rebuild is on the path of every versioned
    // deploy: dropping the key here would skip wrangler's Email Routing plan and
    // record the version without its addresses.
    ...(desired.addresses === undefined ? {} : { addresses: desired.addresses }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CloudflareVersionActivationOptions = {
  /** Reuse an inspected Worker without republishing its domains or other triggers. */
  preserveTriggers?: boolean;
  expectedPreviousVersionId?: string;
  trustedInheritanceVersionIds?: ReadonlyArray<string>;
  recordVerifiedCandidate?: (versionId: string) => void | Promise<void>;
  validateUploadedVersion?: (versionId: string) => Promise<void>;
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
  /** Verify that omitted remote secrets come from the active Worker Version before uploading. */
  verifyInheritedSecrets?: boolean;
  /**
   * Plaintext secrets to attach only to the uploaded candidate version. Supplying every remote
   * `secret_text` binding lets a deployment recover safely when an inactive upload is newer than
   * production; `secret_key` bindings cannot be replaced through this option.
   */
  candidateSecrets?: Readonly<Record<string, string>>;
};

type InternalCloudflareVersionActivationOptions = CloudflareVersionActivationOptions & {
  candidateSecretsFilePath?: string;
};

/** Upload, probe, and atomically activate a verified Worker Version. */
export async function activateCloudflareVersion(
  options: CloudflareVersionActivationOptions,
): Promise<CloudflareVersionActivation> {
  const candidateSecrets = Object.entries(options.candidateSecrets ?? {});
  if (candidateSecrets.length === 0) {
    return activateCloudflareVersionWithSecretsFile(options);
  }

  const directory = mkdtempSync(join(tmpdir(), 'void-version-secrets-'));
  const path = join(directory, 'secrets.json');
  try {
    writeFileSync(path, `${JSON.stringify(Object.fromEntries(candidateSecrets))}\n`, {
      mode: 0o600,
    });
    return await activateCloudflareVersionWithSecretsFile({
      ...options,
      candidateSecretsFilePath: path,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function activateCloudflareVersionWithSecretsFile(
  options: InternalCloudflareVersionActivationOptions,
): Promise<CloudflareVersionActivation> {
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
  if (
    options.expectedPreviousVersionId !== undefined &&
    previous.versionId !== options.expectedPreviousVersionId
  ) {
    return {
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: previous.versionId,
      rollback: 'not-needed',
    };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const previousVersionId = previous.versionId;
  let inheritanceBaseline: Array<RecentCloudflareVersion> | undefined;
  if (options.expectedPreviousVersionId !== undefined || options.verifyInheritedSecrets === true) {
    const recent = await readRecentCloudflareVersionIds(options, commonArgs);
    if (recent === null) {
      return { ok: false, reason: 'inheritance-source-unavailable' };
    }
    const latestVersionId = recent.at(-1)?.id ?? null;
    if (options.expectedPreviousVersionId !== undefined) {
      const activeIndex = recent.findIndex((version) => version.id === previous.versionId);
      const inheritedChain = activeIndex < 0 ? [] : recent.slice(activeIndex);
      const inheritedCandidates = inheritedChain.slice(1).map((version) => version.id);
      const safeInheritanceChain =
        inheritedChain.length > 0 &&
        inheritedChain.every(
          (version, index) =>
            index === 0 || version.number === inheritedChain[index - 1]!.number + 1,
        ) &&
        arraysEqual(inheritedCandidates, options.trustedInheritanceVersionIds ?? []);
      if (!safeInheritanceChain) {
        return {
          ok: false,
          reason: 'inheritance-source-changed',
          activeVersionId: recent.at(-1)?.id ?? null,
          rollback: 'not-needed',
        };
      }
    }
    if (options.verifyInheritedSecrets === true && previous.versionId !== latestVersionId) {
      const replacesAllRemoteSecrets = await candidateReplacesAllRemoteSecrets(
        options,
        commonArgs,
        previous.versionId,
        latestVersionId,
      );
      if (replacesAllRemoteSecrets === null) {
        return { ok: false, reason: 'inheritance-source-unavailable' };
      }
      if (!replacesAllRemoteSecrets) {
        return {
          ok: false,
          reason: 'inheritance-source-changed',
          activeVersionId: latestVersionId,
          rollback: 'not-needed',
        };
      }
    }
    inheritanceBaseline = recent;
  }
  const desiredMetadata = parseCloudflareVersionMessage(options.message);
  let desiredTriggerConfig =
    desiredMetadata?.schema === 2
      ? desiredMetadata.triggerConfig
      : options.configPath
        ? readCloudflareTriggerConfig(options.configPath)
        : triggerConfigFromWrangler({});
  let previousVersion =
    previousVersionId && desiredMetadata?.schema === 2
      ? await readCloudflareVersionInspection(options, commonArgs, previousVersionId)
      : null;
  async function previousIsSecretOnlyDraft(): Promise<boolean> {
    if (!previousVersionId) {
      return false;
    }
    previousVersion ??= await readCloudflareVersionInspection(
      options,
      commonArgs,
      previousVersionId,
    );
    return previousVersion?.isSecretOnlyDraft === true;
  }
  const previousMetadata = desiredMetadata?.schema === 2 ? previousVersion?.metadata : null;
  const continuesOpaqueTriggerPreservation =
    !options.preserveTriggers &&
    !options.previousTrafficConfig &&
    previousMetadata?.schema === 2 &&
    previousMetadata.triggerConfig.preserve === true &&
    desiredTriggerConfig.settingsHash === previousMetadata.triggerConfig.settingsHash &&
    (desiredTriggerConfig.preserveRoutes === true ||
      desiredTriggerConfig.preserveWorkersDev === true ||
      desiredTriggerConfig.preservePreviewUrls === true) &&
    (desiredTriggerConfig.preserveRoutes === true ||
      isDeepStrictEqual(desiredTriggerConfig.routes, previousMetadata.triggerConfig.routes)) &&
    (desiredTriggerConfig.preserveWorkersDev === true ||
      desiredTriggerConfig.workers_dev === previousMetadata.triggerConfig.workers_dev) &&
    (desiredTriggerConfig.preservePreviewUrls === true ||
      desiredTriggerConfig.preview_urls === previousMetadata.triggerConfig.preview_urls) &&
    desiredTriggerConfig.crons.length === 0 &&
    desiredTriggerConfig.queueConsumers.length === 0 &&
    desiredTriggerConfig.workflows.length === 0;
  const previousTrafficConfig =
    options.previousTrafficConfig ??
    (previousMetadata?.schema === 2 && previousMetadata.triggerConfig.preserve !== true
      ? {
          workers_dev: previousMetadata.triggerConfig.workers_dev,
          preview_urls: previousMetadata.triggerConfig.preview_urls,
          routes: previousMetadata.triggerConfig.routes,
        }
      : undefined);
  if (continuesOpaqueTriggerPreservation) {
    desiredTriggerConfig = { ...desiredTriggerConfig, preserve: true };
  } else if (!options.preserveTriggers && desiredMetadata?.schema === 2) {
    const resolved = resolvePreservedTraffic(
      desiredTriggerConfig,
      previousTrafficConfig,
      previous.versionId !== null && !(await previousIsSecretOnlyDraft()),
    );
    if (!resolved) {
      return {
        ok: false,
        reason: 'traffic-preservation-unavailable',
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    desiredTriggerConfig = resolved;
  }
  const message =
    desiredMetadata?.schema === 2
      ? encodeCloudflareVersionMessage(desiredMetadata.migrations, desiredTriggerConfig)
      : options.message;
  const versionedPreviousTriggerConfig =
    previousMetadata?.schema === 2 ? previousMetadata.triggerConfig : undefined;
  const versionedPreviousTriggerConfigWithTraffic =
    versionedPreviousTriggerConfig && previousTrafficConfig
      ? { ...versionedPreviousTriggerConfig, ...previousTrafficConfig }
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
        message,
        ...(options.candidateSecretsFilePath
          ? ['--secrets-file', options.candidateSecretsFilePath]
          : []),
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
    const output = stripVTControlCharacters(`${upload.stdout}\n${upload.stderr}`);
    const cloudflareErrorCode = parseCloudflareErrorCode(output);
    const isBootstrapError =
      cloudflareErrorCode === DURABLE_MIGRATION_VERSION_ERROR ||
      // Recent Wrangler versions reject this locally, before Cloudflare can return 10211.
      /This\s+Worker\s+has\s+a\s+pending\s+Durable\s+Object\s+migration,\s+which\s+cannot\s+be\s+applied\s+by\s+`wrangler\s+versions\s+upload`/i.test(
        output,
      ) ||
      /cannot upload a new version of a worker that does not yet exist/i.test(output);
    if (
      !options.preserveTriggers &&
      isBootstrapError &&
      (previous.versionId === null ||
        options.allowFirstDeploymentBootstrap === true ||
        (await previousIsSecretOnlyDraft()))
    ) {
      return bootstrapFirstDeployment({ ...options, message }, commonArgs, previous.versionId);
    }
    return {
      ok: false,
      reason: 'upload-failed',
      status: upload.status,
      ...commandDiagnosticFields(upload),
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(output) ? { containersUnavailable: true } : {}),
    };
  }

  const output = `${upload.stdout}\n${upload.stderr}`;
  const versionId = output.match(VERSION_ID_RE)?.[1];
  if (!versionId) {
    return { ok: false, reason: 'upload-output-invalid' };
  }
  if (inheritanceBaseline) {
    const recent = await readRecentCloudflareVersionIds(options, commonArgs);
    const previousLatest = inheritanceBaseline.at(-1);
    const expected = [...inheritanceBaseline.map((version) => version.id), versionId].slice(-10);
    if (recent === null) {
      return {
        ok: false,
        reason: 'inheritance-source-unavailable',
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    const uploadedVersion = recent.at(-1);
    if (
      !uploadedVersion ||
      uploadedVersion.id !== versionId ||
      uploadedVersion.number !== (previousLatest?.number ?? 0) + 1 ||
      !arraysEqual(
        recent.map((version) => version.id),
        expected,
      )
    ) {
      return {
        ok: false,
        reason: 'inheritance-source-changed',
        versionId,
        previousVersionId: previous.versionId,
        activeVersionId: uploadedVersion?.id ?? null,
        rollback: 'not-needed',
      };
    }
  }
  await options.validateUploadedVersion?.(versionId);
  if (options.recordVerifiedCandidate) {
    if (!options.validateUploadedVersion) {
      throw new Error('A Worker candidate cannot be recorded without validating its upload.');
    }
    await options.recordVerifiedCandidate(versionId);
  }
  const reportedPreviewUrl = output.match(PREVIEW_URL_RE)?.[1];
  let authenticatedWorkersDevSubdomain = reportedPreviewUrl
    ? extractWorkersDevSubdomain(reportedPreviewUrl)
    : undefined;
  let readinessUrl = reportedPreviewUrl;
  let readinessUsesCustomRoute = false;
  let stagedVersionOverride = false;
  if (!readinessUrl) {
    if (
      !options.preserveTriggers &&
      (previous.versionId === null ||
        options.allowFirstDeploymentBootstrap === true ||
        (await previousIsSecretOnlyDraft()))
    ) {
      return bootstrapFirstDeployment({ ...options, message }, commonArgs, previous.versionId);
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
    const stagingOwnerFailure = await verifyReadinessStagingOwner(
      options,
      commonArgs,
      previous.versionId,
      versionId,
    );
    if (stagingOwnerFailure) {
      return stagingOwnerFailure;
    }
    const staged = await deployVersionPercentages(
      options,
      commonArgs,
      [`${previous.versionId}@100`, `${versionId}@0`],
      message,
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
      const stagingOwnerFailure = await verifyReadinessStagingOwner(
        options,
        commonArgs,
        previous.versionId,
        versionId,
      );
      if (stagingOwnerFailure) {
        return stagingOwnerFailure;
      }
      const staged = await deployVersionPercentages(
        options,
        commonArgs,
        [`${previous.versionId}@100`, `${versionId}@0`],
        message,
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
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'readiness failed',
            [stagedVersionPercentages(previous.versionId, versionId)],
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
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'uploader verification failed',
            [stagedVersionPercentages(previous.versionId, versionId)],
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
  const expectedTrafficBeforeActivation = stagedVersionOverride
    ? stagedVersionPercentages(previous.versionId, versionId)
    : previous.versionId
      ? [{ versionId: previous.versionId, percentage: 100 }]
      : [];
  if (
    ownerBeforeActivation.versionId !== previous.versionId ||
    !productionVersionPercentagesEqual(
      ownerBeforeActivation.versions,
      expectedTrafficBeforeActivation,
    )
  ) {
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
    message,
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
            [
              stagedVersionPercentages(previous.versionId, versionId),
              [{ versionId, percentage: 100 }],
            ],
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
  if (options.preserveTriggers) {
    const owner = await readCurrentProductionVersion(options, commonArgs);
    if (owner.kind !== 'ok' || owner.versionId !== versionId) {
      return {
        ok: false,
        reason: 'deployment-changed',
        versionId,
        previousVersionId: previous.versionId,
        ...(owner.kind === 'ok' ? { activeVersionId: owner.versionId } : {}),
        rollback: 'not-needed',
      };
    }
    return {
      ok: true,
      versionId,
      previousVersionId: previous.versionId,
      previewUrl: publishedCloudflareUrl(options.workerName, desiredTriggerConfig, readinessUrl),
      preservedTriggers: true,
      ...workersDevSubdomainResult(readinessUrl),
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
      versionId,
      versionedPreviousTriggerConfigWithTraffic,
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
    ...(desiredTriggerConfig.preserve ? { preservedTriggers: true } : {}),
    ...(!desiredTriggerConfig.preserve
      ? {
          trafficConfig: {
            workers_dev: desiredTriggerConfig.workers_dev,
            preview_urls: desiredTriggerConfig.preview_urls,
            routes: desiredTriggerConfig.routes,
          },
        }
      : {}),
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
  failedVersionId: string,
  capturedTriggerConfig?: CloudflareTriggerConfig,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  const traffic = await restorePreviousVersion(options, commonArgs, previousVersionId, cause, [
    [{ versionId: failedVersionId, percentage: 100 }],
  ]);
  if (traffic !== 'succeeded' || !previousVersionId) {
    return traffic;
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  // Traffic attachments can change between uploads (for example `void domain
  // add`). Restore the snapshot captured before this deployment, not the older
  // immutable version annotation. Cleanup-only queue names are deliberately not
  // part of this target snapshot.
  let targetTriggerConfig = capturedTriggerConfig;
  if (!targetTriggerConfig) {
    const metadata = await readCloudflareVersionMetadata(options, commonArgs, previousVersionId);
    if (metadata?.schema !== 2) {
      return 'unavailable';
    }
    targetTriggerConfig = metadata.triggerConfig;
  }
  // A preserve marker records that the previous version inherited live trigger
  // state; its routes, schedules, queue consumers, and workflows are therefore
  // intentionally opaque. The traffic snapshot can restore workers.dev, preview
  // visibility, and routes for version activation, but merging those fields into
  // this marker does not turn the unknown trigger surfaces into a restorable
  // snapshot. Traffic is already back on the previous version at this point, so
  // report trigger recovery as unavailable without publishing invented state.
  if (targetTriggerConfig.preserve) {
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
    targetTriggerConfig,
    previousTriggerConfig: failedTriggerConfig,
    knownTriggerConfigs: { [previousVersionId]: targetTriggerConfig },
    publishEmptyCustomDomains: options.publishEmptyCustomDomains,
  });
  return triggers.ok && triggers.targetOwnsTraffic ? 'succeeded' : 'failed';
}

async function readCloudflareVersionMetadata(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  versionId: string,
): Promise<CloudflareVersionMetadata | null> {
  return (await readCloudflareVersionInspection(options, commonArgs, versionId))?.metadata ?? null;
}

type CloudflareVersionInspection = Readonly<{
  metadata: CloudflareVersionMetadata | null;
  isSecretOnlyDraft: boolean;
}>;

async function readCloudflareVersionInspection(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  versionId: string,
): Promise<CloudflareVersionInspection | null> {
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
      if (!isRecord(entry) || entry.id !== versionId) {
        continue;
      }
      const annotations = isRecord(entry.annotations) ? entry.annotations : undefined;
      const message = annotations?.['workers/message'];
      // The list endpoint omits resources. Inspect the exact active version before deciding
      // whether secret provisioning left a placeholder rather than an existing application.
      let draft = entry;
      if (
        annotations?.['workers/triggered_by'] === 'secret' &&
        Object.keys(annotations).length === 1 &&
        !isRecord(entry.resources)
      ) {
        const inspection = await Promise.resolve(
          options.runWrangler(
            ['versions', 'view', versionId, ...commonArgs, '--name', options.workerName, '--json'],
            { capture: true },
          ),
        );
        if (isCleanCommandExit(inspection)) {
          const inspected: unknown = JSON.parse(inspection.stdout);
          if (isRecord(inspected) && inspected.id === versionId) {
            draft = inspected;
          }
        }
      }
      return {
        metadata: typeof message === 'string' ? parseCloudflareVersionMessage(message) : null,
        isSecretOnlyDraft: isWranglerSecretOnlyDraft(draft),
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function readRecentCloudflareVersionIds(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
): Promise<Array<RecentCloudflareVersion> | null> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['versions', 'list', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (isMissingWorkerOutput(output)) {
      return [];
    }
    return null;
  }
  try {
    const versions = JSON.parse(result.stdout) as unknown;
    if (
      !Array.isArray(versions) ||
      !versions.every(
        (version) =>
          isRecord(version) &&
          typeof version.id === 'string' &&
          typeof version.number === 'number' &&
          Number.isSafeInteger(version.number),
      )
    ) {
      return null;
    }
    return versions.map((version) => ({
      id: version.id as string,
      number: version.number as number,
    }));
  } catch {
    return null;
  }
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function candidateReplacesAllRemoteSecrets(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'candidateSecrets' | 'runWrangler' | 'workerName'
  >,
  commonArgs: Array<string>,
  activeVersionId: string | null,
  latestVersionId: string | null,
): Promise<boolean | null> {
  const versionIds = [
    ...new Set([activeVersionId, latestVersionId].filter(Boolean)),
  ] as Array<string>;
  const secretBindings: Array<Array<{ name: string; type: 'secret_key' | 'secret_text' }>> = [];
  for (const versionId of versionIds) {
    const bindings = await readCloudflareVersionSecretBindings(options, commonArgs, versionId);
    if (bindings === null) {
      return null;
    }
    secretBindings.push(bindings);
  }
  return secretBindings.every((bindings) =>
    bindings.every(
      (binding) =>
        binding.type === 'secret_text' &&
        Object.hasOwn(options.candidateSecrets ?? {}, binding.name),
    ),
  );
}

async function readCloudflareVersionSecretBindings(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  versionId: string,
): Promise<Array<{ name: string; type: 'secret_key' | 'secret_text' }> | null> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['versions', 'view', versionId, ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    return null;
  }
  try {
    const version = JSON.parse(result.stdout) as unknown;
    if (!isRecord(version) || version.id !== versionId || !isRecord(version.resources)) {
      return null;
    }
    const bindings = version.resources.bindings;
    if (!Array.isArray(bindings) || !bindings.every(isRecord)) {
      return null;
    }
    const secrets: Array<{ name: string; type: 'secret_key' | 'secret_text' }> = [];
    for (const binding of bindings) {
      if (binding.type !== 'secret_text' && binding.type !== 'secret_key') {
        continue;
      }
      if (typeof binding.name !== 'string') {
        return null;
      }
      secrets.push({ name: binding.name, type: binding.type });
    }
    return secrets;
  } catch {
    return null;
  }
}

/**
 * The Versions API cannot create a Worker or its initial Durable Object migration history, and
 * some accounts do not expose a version preview until their first ordinary deployment. A
 * brand-new Worker can therefore need one ordinary deploy before later releases use preview-first
 * version activation. This fallback requires prior proof that no application had been deployed.
 */
async function bootstrapFirstDeployment(
  options: InternalCloudflareVersionActivationOptions,
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
        ...(options.candidateSecretsFilePath
          ? ['--secrets-file', options.candidateSecretsFilePath]
          : []),
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
      ...commandDiagnosticFields(bootstrap),
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
    // A new Worker also needs its public route/DNS to propagate. Subsequent
    // version previews can use the shorter retry window, but bootstrap needs
    // more than its roughly six seconds of backoff. Keep an overall deadline.
    options.readinessAttempts ?? 30,
    60_000,
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

function commandDiagnosticFields(result: CloudflareCommandResult): { diagnostic?: string } {
  const diagnostic = cloudflareCommandDiagnostic(result);
  return diagnostic ? { diagnostic } : {};
}

function isMissingWorkerOutput(output: string): boolean {
  return (
    parseCloudflareErrorCode(output) === 10007 ||
    /no deployments|\bworker\b.*\b(?:does not exist|not found)\b/i.test(output)
  );
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
): Promise<CurrentProductionVersion> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['deployments', 'status', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (isMissingWorkerOutput(output)) {
      return { kind: 'ok', versionId: null, versions: [] };
    }
    return { kind: 'failed', status: result.status };
  }
  try {
    const deployment = JSON.parse(result.stdout) as ProductionDeployment;
    const versions = (deployment.versions ?? []).map((version) => ({
      versionId: typeof version.version_id === 'string' ? version.version_id : '',
      percentage: Number(version.percentage),
    }));
    if (
      versions.some(
        (version) =>
          version.versionId.length === 0 ||
          !Number.isFinite(version.percentage) ||
          version.percentage < 0 ||
          version.percentage > 100,
      )
    ) {
      return { kind: 'failed', status: result.status };
    }
    const activeVersions = versions.filter((version) => version.percentage > 0);
    if (
      activeVersions.length > 1 ||
      (activeVersions.length === 1 && activeVersions[0]?.percentage !== 100)
    ) {
      return { kind: 'split' };
    }
    const active = activeVersions[0];
    return {
      kind: 'ok',
      versionId: active?.versionId ?? null,
      versions,
    };
  } catch {
    return { kind: 'failed', status: result.status };
  }
}

function productionVersionPercentagesEqual(
  actual: ReadonlyArray<ProductionVersionPercentage>,
  expected: ReadonlyArray<ProductionVersionPercentage>,
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((entry) =>
      actual.some(
        (candidate) =>
          candidate.versionId === entry.versionId && candidate.percentage === entry.percentage,
      ),
    )
  );
}

function stagedVersionPercentages(
  previousVersionId: string | null,
  versionId: string,
): Array<ProductionVersionPercentage> {
  return previousVersionId
    ? [
        { versionId: previousVersionId, percentage: 100 },
        { versionId, percentage: 0 },
      ]
    : [];
}

async function verifyReadinessStagingOwner(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  versionId: string,
): Promise<Extract<CloudflareVersionActivation, { ok: false }> | null> {
  const owner = await readCurrentProductionVersion(options, commonArgs);
  if (owner.kind === 'failed') {
    return {
      ok: false,
      reason: 'status-failed',
      status: owner.status,
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  if (owner.kind === 'split') {
    return {
      ok: false,
      reason: 'traffic-split-unsupported',
      versionId,
      previousVersionId,
      rollback: 'not-needed',
    };
  }
  const expected = previousVersionId ? [{ versionId: previousVersionId, percentage: 100 }] : [];
  if (
    owner.versionId !== previousVersionId ||
    !productionVersionPercentagesEqual(owner.versions, expected)
  ) {
    return {
      ok: false,
      reason: 'deployment-changed',
      versionId,
      previousVersionId,
      activeVersionId: owner.versionId,
      rollback: 'not-needed',
    };
  }
  return null;
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
  timeoutMs = Number.POSITIVE_INFINITY,
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
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    let response: Response | undefined;
    try {
      response = await fetcher(url, {
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
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
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
    } finally {
      if (response && !response.bodyUsed) {
        await response.body?.cancel().catch(() => {});
      }
    }
    if (attempt + 1 < attempts) {
      const delay = Math.min(250 * 2 ** attempt, 2_000, deadline - Date.now());
      if (delay > 0) {
        await sleep(delay);
      }
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
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'workerName' | 'preserveTriggers' | 'configPath'
  >,
  commonArgs: Array<string>,
  percentages: Array<string>,
  message: string,
): Promise<CloudflareCommandResult> {
  const metadata = parseCloudflareVersionMessage(message);
  if (
    (options.preserveTriggers || (metadata?.schema === 2 && metadata.triggerConfig.preserve)) &&
    options.configPath
  ) {
    return deployCloudflareVersionTraffic({
      ...options,
      configPath: options.configPath,
      percentages,
      message,
    });
  }
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

/** Change version traffic without synchronizing Worker settings from local config. */
export async function deployCloudflareVersionTraffic(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  percentages: Array<string>;
  message: string;
}): Promise<CloudflareCommandResult> {
  const config = pickWranglerTriggerContext(parseRootWranglerConfig(options.configPath));
  const directory = mkdtempSync(join(tmpdir(), 'void-version-traffic-'));
  const path = join(directory, 'wrangler.json');
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    return await options.runWrangler(
      [
        'versions',
        'deploy',
        ...options.percentages,
        '-c',
        path,
        '--env=',
        '--name',
        options.workerName,
        '--message',
        options.message,
        '--yes',
      ],
      { capture: false },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function restorePreviousVersion(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  cause: string,
  expectedOwnedTraffic: ReadonlyArray<ReadonlyArray<ProductionVersionPercentage>>,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  if (!previousVersionId) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const owner = await readCurrentProductionVersion(options, commonArgs);
  if (
    owner.kind !== 'ok' ||
    !expectedOwnedTraffic.some((expected) =>
      productionVersionPercentagesEqual(owner.versions, expected),
    )
  ) {
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
