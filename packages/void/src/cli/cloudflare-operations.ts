import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  encodeCloudflareVersionMessage,
  deployCloudflareVersionTraffic,
  parseCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  readBindingFieldPresence,
  readWranglerTopLevelString,
  resolveD1MigrateTarget,
  type CloudflareVersionMetadata,
} from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { materializeCloudflareConfig, persistCloudflareConfig } from '../cloudflare-config.ts';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { resolveWranglerArgv } from './preset.ts';
import {
  assertNoTransportRedirectInProjectDotenv,
  deleteEnvVarCaseAware,
  provisionEnv,
  resolvePinnedApiBaseUrl,
} from './provision.ts';
import {
  readWranglerCustomDomains,
  readWranglerPublishedTrafficSnapshot,
  writeWranglerPublishedTrafficSnapshot,
  updateWranglerCustomDomain,
  type WranglerCustomDomain,
} from './wrangler.ts';

export type CloudflareOperationResult = {
  status: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

export type CloudflareOperationRunner = (
  args: Array<string>,
  options: { capture: boolean; input?: string },
) => CloudflareOperationResult | Promise<CloudflareOperationResult>;

export type CloudflareOperationContext = {
  accountId: string;
  apiBaseUrl: string;
  configPath: string;
  workerName: string;
  runWrangler: CloudflareOperationRunner;
};

export type CloudflareCustomDomainPublisher = (
  context: CloudflareOperationContext,
) => Promise<void>;

export type CloudflareWorkerVersion = {
  id: string;
  createdAt: string | null;
  message: string | null;
  metadata: CloudflareVersionMetadata | null;
};

export type CloudflareWorkerStatus = {
  workerName: string;
  activeVersionId: string | null;
  deployedVersionIds: Array<string>;
  versions: Array<CloudflareWorkerVersion>;
};

export type CloudflareD1Context = {
  operation: CloudflareOperationContext;
  binding: string;
  migrateToken: string;
  migrationsDir: string;
  migrationsTable: string;
};

export function resolveCloudflareOperationContext(
  root: string,
  runner?: CloudflareOperationRunner,
): CloudflareOperationContext {
  const configPath = discoverRootWranglerConfig(root);
  if (!existsSync(configPath)) {
    throw new Error(`No Cloudflare config found at "${configPath}". Run \`void init\` first.`);
  }
  assertNoOperationConfigOverride(root);
  assertNoTransportRedirectInProjectDotenv(root);
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name');
  if (!workerName) {
    throw new Error(
      `Cloudflare config "${configPath}" has no worker name. Run \`void init\` first.`,
    );
  }
  const accountId =
    readWranglerTopLevelString(config, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    throw new Error(
      'No Cloudflare account is pinned. Set cloudflare.account_id in void.config.ts or CLOUDFLARE_ACCOUNT_ID.',
    );
  }
  const apiBaseUrl = resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(config, 'compliance_region'),
  );
  return {
    accountId,
    apiBaseUrl,
    configPath,
    workerName,
    runWrangler: runner ?? createCloudflareOperationRunner(root, accountId, apiBaseUrl),
  };
}

export async function listCloudflareSecrets(
  context: CloudflareOperationContext,
): Promise<Array<string>> {
  const result = await run(context, ['secret', 'list', ...targetArgs(context), '--format', 'json']);
  const parsed = parseJson(result.stdout, 'Cloudflare secret list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare secret list returned an unexpected response.');
  }
  return parsed
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const value = entry as Record<string, unknown>;
      return typeof value.name === 'string' ? value.name : null;
    })
    .filter((name): name is string => name !== null)
    .sort();
}

export async function putCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
  value: string,
): Promise<void> {
  await run(context, ['secret', 'put', name, ...targetArgs(context)], { input: value });
}

export async function syncCloudflareSecrets(
  context: CloudflareOperationContext,
  secrets: ReadonlyArray<{ name: string; value: string }>,
): Promise<void> {
  const values = Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
  await run(context, ['secret', 'bulk', ...targetArgs(context)], {
    input: `${JSON.stringify(values)}\n`,
  });
}

export async function deleteCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
): Promise<void> {
  await run(context, ['secret', 'delete', name, ...targetArgs(context)]);
}

export function resolveCloudflareD1Context(
  root: string,
  binding: string,
  runner?: CloudflareOperationRunner,
): CloudflareD1Context {
  const operation = resolveCloudflareOperationContext(root, runner);
  const config = parseRootWranglerConfig(operation.configPath);
  const target = resolveD1MigrateTarget(config, binding);
  if (!target.ok) {
    throw new Error(`Cannot resolve D1 binding ${binding}: ${target.reason}.`);
  }
  const migrationsDir = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_dir');
  const migrationsTable = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_table',
  );
  if (
    migrationsDir.present &&
    (typeof migrationsDir.value !== 'string' || migrationsDir.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_dir.`);
  }
  if (
    migrationsTable.present &&
    (typeof migrationsTable.value !== 'string' || migrationsTable.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_table.`);
  }
  return {
    operation,
    binding,
    migrateToken: target.token,
    migrationsDir: migrationsDir.present ? (migrationsDir.value as string) : 'db/migrations',
    migrationsTable: migrationsTable.present ? (migrationsTable.value as string) : 'd1_migrations',
  };
}

export async function executeCloudflareD1Sql(
  context: CloudflareD1Context,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await run(context.operation, [
    'd1',
    'execute',
    context.migrateToken,
    '--remote',
    '--command',
    sql,
    '--json',
    '-c',
    context.operation.configPath,
    '--env=',
  ]);
  const parsed = parseJson(result.stdout, 'Cloudflare D1 execute');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare D1 execute returned an unexpected response.');
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Cloudflare D1 execute returned a malformed result.');
    }
    const resultRows = (item as Record<string, unknown>).results;
    if (!Array.isArray(resultRows)) {
      continue;
    }
    for (const row of resultRows) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    }
  }
  return rows;
}

export async function readCloudflareD1Migrations(
  context: CloudflareD1Context,
): Promise<Array<string>> {
  const table = context.migrationsTable.replace(/"/g, '""');
  try {
    const rows = await executeCloudflareD1Sql(context, `SELECT name FROM "${table}" ORDER BY name`);
    return rows
      .map((row) => (typeof row.name === 'string' ? row.name : null))
      .filter((name): name is string => name !== null);
  } catch (error) {
    if (/no such table/i.test(errorMessage(error))) {
      return [];
    }
    throw error;
  }
}

export async function applyCloudflareD1Migrations(context: CloudflareD1Context): Promise<void> {
  await run(
    context.operation,
    [
      'd1',
      'migrations',
      'apply',
      context.migrateToken,
      '--remote',
      '-c',
      context.operation.configPath,
      '--env=',
    ],
    { capture: false },
  );
}

export async function readCloudflareWorkerStatus(
  context: CloudflareOperationContext,
): Promise<CloudflareWorkerStatus> {
  const [deployment, deployments, versions] = await Promise.all([
    run(context, ['deployments', 'status', ...targetArgs(context), '--json']),
    run(context, ['deployments', 'list', ...targetArgs(context), '--json']),
    run(context, ['versions', 'list', ...targetArgs(context), '--json']),
  ]);
  const activeVersionId = parseActiveVersionId(deployment.stdout);
  const deployedVersionIds = parseCloudflareDeployedVersionIds(deployments.stdout);
  if (activeVersionId && !deployedVersionIds.includes(activeVersionId)) {
    deployedVersionIds.push(activeVersionId);
  }
  return {
    workerName: context.workerName,
    activeVersionId,
    deployedVersionIds,
    versions: parseCloudflareVersions(versions.stdout),
  };
}

/** Return only versions that Cloudflare records as members of a production deployment. */
export function parseCloudflareDeployedVersionIds(value: string): Array<string> {
  const parsed = parseJson(value, 'Cloudflare deployment list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare deployment list returned an unexpected response.');
  }
  const ids = new Set<string>();
  parsed.forEach((deployment, deploymentIndex) => {
    if (
      typeof deployment !== 'object' ||
      deployment === null ||
      !Array.isArray((deployment as Record<string, unknown>).versions)
    ) {
      throw new Error(`Cloudflare deployment list entry ${deploymentIndex + 1} is malformed.`);
    }
    for (const version of (deployment as { versions: Array<unknown> }).versions) {
      if (
        typeof version !== 'object' ||
        version === null ||
        typeof (version as Record<string, unknown>).version_id !== 'string' ||
        typeof (version as Record<string, unknown>).percentage !== 'number' ||
        !Number.isFinite((version as Record<string, number>).percentage) ||
        (version as Record<string, number>).percentage < 0 ||
        (version as Record<string, number>).percentage > 100
      ) {
        throw new Error(`Cloudflare deployment list entry ${deploymentIndex + 1} is malformed.`);
      }
      // A version staged at 0% for readiness is present in deployment history
      // even when its probe failed. It has never served production traffic and
      // must not become a rollback candidate.
      if ((version as { percentage: number }).percentage > 0) {
        ids.add((version as { version_id: string }).version_id);
      }
    }
  });
  return [...ids];
}

export function parseCloudflareVersions(value: string): Array<CloudflareWorkerVersion> {
  const parsed = parseJson(value, 'Cloudflare version list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare version list returned an unexpected response.');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') {
      throw new Error(`Cloudflare version list entry ${index + 1} is malformed.`);
    }
    const metadata =
      typeof entry.metadata === 'object' && entry.metadata !== null
        ? (entry.metadata as Record<string, unknown>)
        : undefined;
    const annotations =
      typeof entry.annotations === 'object' && entry.annotations !== null
        ? (entry.annotations as Record<string, unknown>)
        : undefined;
    const message =
      typeof annotations?.['workers/message'] === 'string' ? annotations['workers/message'] : null;
    return {
      id: entry.id,
      createdAt: typeof metadata?.created_on === 'string' ? metadata.created_on : null,
      message,
      metadata: parseCloudflareVersionMessage(message),
    };
  });
}

export function parseActiveVersionId(value: string): string | null {
  const parsed = parseJson(value, 'Cloudflare deployment status');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const deployment = parsed as Record<string, unknown>;
  if (!Array.isArray(deployment.versions)) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const versions = deployment.versions;
  const active = versions.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      Number((entry as Record<string, unknown>).percentage) === 100,
  );
  if (active === undefined) {
    return null;
  }
  if (
    typeof active !== 'object' ||
    active === null ||
    typeof (active as Record<string, unknown>).version_id !== 'string'
  ) {
    throw new Error('Cloudflare deployment status has a malformed active version.');
  }
  return (active as Record<string, string>).version_id;
}

export async function activateCloudflareExistingVersion(
  context: CloudflareOperationContext,
  target: CloudflareWorkerVersion,
  current?: CloudflareWorkerVersion,
): Promise<void> {
  // Without a complete snapshot, use Cloudflare's code-only rollback semantics.
  // Keeping triggers unchanged also makes the inverse recovery possible.
  if (
    target.metadata?.schema !== 2 ||
    target.metadata.triggerConfig.preserve ||
    !current ||
    current.metadata?.schema !== 2 ||
    current.metadata.triggerConfig.preserve
  ) {
    const owner = await readActiveCloudflareVersionId(context);
    if (current && owner !== current.id) {
      throw new Error(
        'Cloudflare production changed before rollback. Refresh deployment status and retry.',
      );
    }
    const result = await deployCloudflareVersionTraffic({
      ...context,
      percentages: [`${target.id}@100`],
      message: 'Void rollback preserving existing routes and triggers.',
    });
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error(
        'Cloudflare could not complete rollback. Refresh deployment status before retrying.',
      );
    }
    if ((await readActiveCloudflareVersionId(context)) !== target.id) {
      throw new Error(
        'Cloudflare rollback was superseded or could not be verified. Refresh deployment status.',
      );
    }
    return;
  }
  const targetTriggerConfig = target.metadata.triggerConfig;
  const publishedTraffic = readWranglerPublishedTrafficSnapshot(context.configPath);
  const currentTriggerConfig =
    current?.metadata?.schema === 2
      ? publishedTraffic
        ? { ...current.metadata.triggerConfig, ...publishedTraffic }
        : current.metadata.triggerConfig
      : undefined;
  const message = encodeCloudflareVersionMessage(target.metadata.migrations, targetTriggerConfig);
  const expectedVersionId = current?.id ?? (await readActiveCloudflareVersionId(context));
  const ownerBeforeActivation = await readActiveCloudflareVersionId(context);
  if (ownerBeforeActivation !== expectedVersionId) {
    throw new Error(
      `Cloudflare production changed from ${expectedVersionId ?? 'no active version'} to ${ownerBeforeActivation ?? 'no active version'} before rollback activation. Retry from fresh deployment status.`,
    );
  }
  await run(
    context,
    [
      'versions',
      'deploy',
      `${target.id}@100`,
      ...targetArgs(context),
      '--message',
      message,
      '--yes',
    ],
    { capture: false },
  );
  const knownTriggerConfigs: Record<string, typeof targetTriggerConfig> = {
    [target.id]: targetTriggerConfig,
  };
  if (currentTriggerConfig && current) {
    knownTriggerConfigs[current.id] = currentTriggerConfig;
  }
  const triggers = await stabilizeCloudflareVersionTriggers({
    runWrangler: context.runWrangler,
    workerName: context.workerName,
    configPath: context.configPath,
    targetVersionId: target.id,
    targetTriggerConfig,
    previousTriggerConfig: currentTriggerConfig,
    knownTriggerConfigs,
    publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(context),
    publishEmptyCrons: createCloudflareEmptyCronPublisher(context),
  });
  if (triggers.ok && triggers.targetOwnsTraffic) {
    writeWranglerPublishedTrafficSnapshot(context.configPath, {
      workers_dev: targetTriggerConfig.workers_dev,
      preview_urls: targetTriggerConfig.preview_urls,
      routes: [...targetTriggerConfig.routes],
    });
    return;
  }

  if (triggers.ok) {
    throw new Error(
      `Cloudflare rollback to ${target.id} was superseded by ${triggers.activeVersionId}; Void restored the active version's triggers. Refresh deployment status before retrying.`,
    );
  }
  if (triggers.activeVersionId && triggers.activeVersionId !== target.id) {
    throw new Error(
      `Cloudflare rollback to ${target.id} was superseded by ${triggers.activeVersionId}, but Void could not restore that version's triggers (${triggers.reason}). Inspect the Worker immediately.`,
    );
  }
  if (!triggers.activeVersionId) {
    throw new Error(
      `Cloudflare activated ${target.id}, but Void could not verify which version owns production while synchronizing triggers (${triggers.reason}). Inspect the Worker immediately.`,
    );
  }

  if (!currentTriggerConfig || !current) {
    throw new Error(
      `Cloudflare activated version ${target.id}, but trigger synchronization failed and no prior trigger snapshot was available. Inspect the Worker immediately.`,
    );
  }
  const ownerBeforeCompensation = await readActiveCloudflareVersionId(context);
  if (ownerBeforeCompensation !== target.id) {
    const repair = await stabilizeCloudflareVersionTriggers({
      runWrangler: context.runWrangler,
      workerName: context.workerName,
      configPath: context.configPath,
      targetVersionId: target.id,
      targetTriggerConfig,
      previousTriggerConfig: currentTriggerConfig,
      knownTriggerConfigs,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(context),
      publishEmptyCrons: createCloudflareEmptyCronPublisher(context),
    });
    throw new Error(
      repair.ok
        ? `Cloudflare rollback to ${target.id} was superseded by ${repair.activeVersionId}; Void restored the active version's triggers. Refresh deployment status before retrying.`
        : `Cloudflare rollback to ${target.id} was superseded by ${ownerBeforeCompensation ?? 'an unknown version'}, but Void could not restore the active triggers (${repair.reason}). Inspect the Worker immediately.`,
    );
  }
  let recoveryFailure: string | null = null;
  try {
    await run(
      context,
      [
        'versions',
        'deploy',
        `${current.id}@100`,
        ...targetArgs(context),
        '--message',
        `Void automatic rollback after trigger synchronization failed.`,
        '--yes',
      ],
      { capture: false },
    );
    const restoredTriggers = await stabilizeCloudflareVersionTriggers({
      runWrangler: context.runWrangler,
      workerName: context.workerName,
      configPath: context.configPath,
      targetVersionId: current.id,
      targetTriggerConfig: currentTriggerConfig,
      previousTriggerConfig: targetTriggerConfig,
      knownTriggerConfigs,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher(context),
      publishEmptyCrons: createCloudflareEmptyCronPublisher(context),
    });
    if (!restoredTriggers.ok) {
      recoveryFailure = 'previous trigger synchronization failed';
    } else if (!restoredTriggers.targetOwnsTraffic) {
      recoveryFailure = `recovery was superseded by ${restoredTriggers.activeVersionId}`;
    } else {
      writeWranglerPublishedTrafficSnapshot(context.configPath, {
        workers_dev: currentTriggerConfig.workers_dev,
        preview_urls: currentTriggerConfig.preview_urls,
        routes: [...currentTriggerConfig.routes],
      });
    }
  } catch (error) {
    recoveryFailure = errorMessage(error);
  }
  throw new Error(
    recoveryFailure
      ? `Cloudflare trigger synchronization failed after activating ${target.id}, and automatic recovery also failed: ${recoveryFailure}`
      : `Cloudflare trigger synchronization failed after activating ${target.id}; traffic and triggers were restored to ${current.id}.`,
  );
}

async function readActiveCloudflareVersionId(
  context: CloudflareOperationContext,
): Promise<string | null> {
  const result = await run(context, ['deployments', 'status', ...targetArgs(context), '--json']);
  return parseActiveVersionId(result.stdout);
}

export async function tailCloudflareWorker(
  context: CloudflareOperationContext,
  options: { filter?: string; versionId?: string; status?: 'error' },
): Promise<void> {
  const args = [
    'tail',
    context.workerName,
    '-c',
    context.configPath,
    '--env=',
    '--format',
    'pretty',
  ];
  if (options.filter) {
    args.push('--search', options.filter);
  }
  if (options.versionId) {
    args.push('--version-id', options.versionId);
  }
  if (options.status) {
    args.push('--status', options.status);
  }
  await run(context, args, { capture: false });
}

export function listCloudflareDomains(root: string): Array<WranglerCustomDomain> {
  return readWranglerCustomDomains(root).domains;
}

export async function changeCloudflareDomain(
  root: string,
  hostname: string,
  action: 'add' | 'delete',
  runner?: CloudflareOperationRunner,
  emptyDomainPublisher?: CloudflareCustomDomainPublisher,
): Promise<{ modified: boolean; domains: Array<WranglerCustomDomain> }> {
  const context = resolveCloudflareOperationContext(root, runner);
  const before = readWranglerCustomDomains(root);
  const original = readFileSync(before.configPath, 'utf-8');
  const update = updateWranglerCustomDomain(root, hostname, action);
  if (!update.modified) {
    return update;
  }
  const triggerConfigDir = mkdtempSync(join(tmpdir(), 'void-domain-triggers-'));
  const triggerConfigPath = join(triggerConfigDir, 'wrangler.json');
  const deployRoutes = async (): Promise<void> => {
    if (readWranglerCustomDomains(root).domains.length === 0) {
      await (emptyDomainPublisher ?? publishEmptyCloudflareCustomDomainSet)(context);
      return;
    }
    writeDomainTriggerConfig(context, before.configPath, triggerConfigPath);
    await run(
      context,
      ['triggers', 'deploy', '-c', triggerConfigPath, '--env=', '--name', context.workerName],
      { capture: false },
    );
  };
  try {
    await deployRoutes();
  } catch (error) {
    writeFileSync(before.configPath, original);
    persistCloudflareConfig(root);
    try {
      await deployRoutes();
    } catch (restoreError) {
      throw new Error(
        `Cloudflare rejected the domain trigger update and also rejected the automatic remote restore. ` +
          `The local Wrangler config was restored, but remote route state may be partially applied. ` +
          `${errorMessage(error)} Restore failed: ${errorMessage(restoreError)}`,
      );
    }
    throw new Error(
      `Cloudflare rejected the domain trigger update; both the local config and remote triggers were restored. ${errorMessage(error)}`,
    );
  } finally {
    rmSync(triggerConfigDir, { recursive: true, force: true });
  }
  const publishedTraffic = readCloudflareTriggerConfig(before.configPath);
  writeWranglerPublishedTrafficSnapshot(before.configPath, {
    workers_dev: publishedTraffic.workers_dev,
    preview_urls: publishedTraffic.preview_urls,
    routes: [...publishedTraffic.routes],
  });
  return update;
}

/**
 * Publish an explicit empty Custom Domain set through the pinned cf transport.
 * Trigger deploy omits empty domain sets; this operation must reconcile them
 * explicitly using the same verified browser/API credentials as other commands.
 */
export async function publishEmptyCloudflareCustomDomainSet(
  context: CloudflareOperationContext,
): Promise<void> {
  await run(context, ['triggers', 'clear-domains', ...targetArgs(context)]);
}

/** Adapt the direct empty-domain API call to the deployment package's result contract. */
export function createCloudflareEmptyDomainPublisher(
  context: CloudflareOperationContext,
): () => Promise<CloudflareOperationResult> {
  return async () => {
    try {
      await publishEmptyCloudflareCustomDomainSet(context);
      return { status: 0, stdout: '', stderr: '' };
    } catch (error) {
      return { status: 1, stdout: '', stderr: errorMessage(error), error: errorMessage(error) };
    }
  };
}

/** Publish an explicit empty Cron Trigger set through Void's pinned cf transport. */
export function createCloudflareEmptyCronPublisher(
  context: CloudflareOperationContext,
): () => Promise<CloudflareOperationResult> {
  return async () => {
    try {
      return await run(context, ['triggers', 'clear-crons', ...targetArgs(context)]);
    } catch (error) {
      return { status: 1, stdout: '', stderr: errorMessage(error), error: errorMessage(error) };
    }
  };
}

/**
 * Build a route-only Wrangler config for a domain update. `triggers deploy`
 * also reconciles cron, queue-consumer, and workflow triggers found in its
 * config, so using the root config here could drop generated schedules or
 * replay stale consumers. The isolated config carries only the route surface
 * this command owns and the workers.dev switches that route reconciliation
 * also evaluates.
 */
function writeDomainTriggerConfig(
  context: CloudflareOperationContext,
  sourceConfigPath: string,
  triggerConfigPath: string,
): void {
  const source = parseRootWranglerConfig(sourceConfigPath);
  const config: Record<string, unknown> = {
    name: context.workerName,
    account_id: context.accountId,
    routes: Array.isArray(source.routes) ? source.routes : [],
  };
  for (const field of ['workers_dev', 'preview_urls'] as const) {
    if (typeof source[field] === 'boolean') {
      config[field] = source[field];
    }
  }
  const compatibilityDate = readWranglerTopLevelString(source, 'compatibility_date');
  if (compatibilityDate) {
    config.compatibility_date = compatibilityDate;
  }
  writeFileSync(triggerConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function targetArgs(context: CloudflareOperationContext): Array<string> {
  return ['-c', context.configPath, '--env=', '--name', context.workerName];
}

async function run(
  context: CloudflareOperationContext,
  args: Array<string>,
  options?: { capture?: boolean; input?: string },
): Promise<CloudflareOperationResult> {
  const result = await Promise.resolve(
    context.runWrangler(args, {
      capture: options?.capture ?? true,
      input: options?.input,
    }),
  );
  if (
    result.status !== 0 ||
    result.signal != null ||
    (result.error !== undefined && result.error !== null && result.error !== '')
  ) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error || 'unknown error';
    throw new Error(
      `Cloudflare command failed (${args.slice(0, 2).join(' ')}, exit ${result.status}): ${detail}`,
    );
  }
  return result;
}

function createCloudflareOperationRunner(
  root: string,
  accountId: string,
  apiBaseUrl: string,
): CloudflareOperationRunner {
  const [command, ...prefix] = resolveWranglerArgv(root);
  return (args, options) => {
    const env = provisionEnv({ accountId, apiBaseUrl });
    deleteEnvVarCaseAware(env, 'WRANGLER_CI_OVERRIDE_NAME');
    if (!options.capture) {
      env.WRANGLER_LOG = 'none';
    }
    const result = spawnSync(command, [...prefix, ...args], {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf-8',
      input: options.input,
      stdio:
        options.input !== undefined
          ? ['pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit']
          : options.capture
            ? ['ignore', 'pipe', 'pipe']
            : 'inherit',
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
    };
  };
}

function discoverRootWranglerConfig(root: string): string {
  return materializeCloudflareConfig(root);
}

function assertNoOperationConfigOverride(root: string): void {
  if (process.env.CLOUDFLARE_ENV?.trim()) {
    throw new Error(
      'CLOUDFLARE_ENV is set. Void Cloudflare operations target the top-level config only.',
    );
  }
  if (process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH?.trim()) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. Void Cloudflare operations use the root Wrangler config only.',
    );
  }
  for (const file of ['.env', '.env.local', '.env.', '.env..local']) {
    const keys = scanWranglerDotenvKeys(join(root, file));
    const containsOverride =
      process.platform === 'win32'
        ? [...keys].some((key) => key.toLowerCase() === 'wrangler_ci_override_name')
        : keys.has('WRANGLER_CI_OVERRIDE_NAME');
    if (containsOverride) {
      throw new Error(
        `Project file "${file}" sets WRANGLER_CI_OVERRIDE_NAME, which can replace the pinned Worker name. Remove it before running this command.`,
      );
    }
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
