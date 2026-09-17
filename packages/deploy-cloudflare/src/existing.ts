import { isDeepStrictEqual } from 'node:util';
import { parseRootWranglerConfig } from './config.ts';
import type { CloudflareCommandRunner } from './execute.ts';

export type ExistingCloudflareWorker = {
  versionId: string;
  bindings: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
  script: Record<string, unknown>;
};

type ExistingCloudflareWorkerOptions = {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  versionId?: string;
};

export type CloudflareWorkerMigrationTagOptions = {
  runWrangler: CloudflareCommandRunner;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
};

/** Read the deployed version, not the most recently uploaded candidate. */
export async function readExistingCloudflareWorker(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  versionId?: string;
}): Promise<ExistingCloudflareWorker> {
  const worker = await readCloudflareWorker(options, false);
  if (!worker) {
    throw new Error(`Cloudflare Worker "${options.workerName}" does not have an active version.`);
  }
  return worker;
}

async function readCloudflareWorker(
  options: ExistingCloudflareWorkerOptions,
  allowMissing: boolean,
): Promise<ExistingCloudflareWorker | null> {
  const target = ['-c', options.configPath, '--env=', '--name', options.workerName];
  const read = async (
    args: Array<string>,
    missingIsNull = false,
  ): Promise<Record<string, unknown> | null> => {
    const result = await options.runWrangler([...args, ...target, '--json'], { capture: true });
    if (result.status !== 0 || result.signal || result.error) {
      if (missingIsNull && isMissingWorkerOutput(`${result.stdout}\n${result.stderr}`)) {
        return null;
      }
      throw new Error(
        `Could not verify existing Cloudflare Worker "${options.workerName}". Check the account, Worker name, and Cloudflare permissions before retrying.`,
      );
    }
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (record(value)) {
        return value;
      }
    } catch {
      /* Report no response contents: bindings may contain private values. */
    }
    throw new Error('Cloudflare returned an invalid existing Worker response.');
  };
  const deployment = options.versionId
    ? { versions: [{ version_id: options.versionId, percentage: 100 }] }
    : await read(['deployments', 'status'], allowMissing);
  if (deployment === null) {
    return null;
  }
  const versions = deployment.versions;
  if (allowMissing && Array.isArray(versions) && versions.length === 0) {
    return null;
  }
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    !record(versions[0]) ||
    versions[0].percentage !== 100 ||
    typeof versions[0].version_id !== 'string'
  ) {
    throw new Error(
      'The existing Worker must have one deployed version receiving all traffic. Finish any gradual rollout before linking.',
    );
  }
  const versionId = versions[0].version_id;
  const version = await read(['versions', 'view', versionId]);
  if (version === null) {
    throw new Error('Cloudflare did not return the existing Worker configuration.');
  }
  const resources = version.resources;
  if (
    version.id !== versionId ||
    !record(resources) ||
    !Array.isArray(resources.bindings) ||
    !resources.bindings.every(record) ||
    !record(resources.script_runtime) ||
    !record(resources.script)
  ) {
    throw new Error('Cloudflare did not return the existing Worker configuration.');
  }
  const after = options.versionId ? deployment : await read(['deployments', 'status']);
  if (after === null || !isDeepStrictEqual(deployment.versions, after.versions)) {
    throw new Error(
      'Cloudflare production changed while linking. Retry from the current deployment.',
    );
  }
  return {
    versionId,
    bindings: resources.bindings,
    runtime: resources.script_runtime,
    script: resources.script,
  };
}

/** Parse legacy version-detail shapes; this is not authoritative Worker migration state. */
export function readCloudflareVersionMigrationTag(version: unknown): string | null {
  if (!record(version)) {
    return null;
  }
  const resources = record(version.resources) ? version.resources : undefined;
  const candidates = [
    resources && record(resources.script_runtime) ? resources.script_runtime.migration_tag : null,
    resources && record(resources.script) ? resources.script.migration_tag : null,
    record(version.script) ? version.script.migration_tag : null,
    version.migration_tag,
  ];
  const tag = candidates.find((candidate) => typeof candidate === 'string');
  return typeof tag === 'string' && tag.length > 0 ? tag : null;
}

/** Read the authoritative migration tag from Worker script metadata. */
export async function readCloudflareWorkerMigrationTag(
  options: CloudflareWorkerMigrationTagOptions,
): Promise<string | null> {
  const auth = await readCloudflareApiAuthentication(options.runWrangler);
  const endpoint = `${options.apiBaseUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      `Could not verify Durable Object migration state for Cloudflare Worker "${options.workerName}".`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Cloudflare returned an invalid Durable Object migration response for Worker "${options.workerName}".`,
    );
  }
  if (!response.ok || !record(body) || body.success !== true || !Array.isArray(body.result)) {
    throw new Error(
      `Could not verify Durable Object migration state for Cloudflare Worker "${options.workerName}".`,
    );
  }
  const worker = body.result.find(
    (candidate) => record(candidate) && candidate.id === options.workerName,
  );
  if (!record(worker)) {
    throw new Error(
      `Cloudflare did not return migration state for Worker "${options.workerName}".`,
    );
  }
  if (worker.migration_tag === undefined || worker.migration_tag === null) {
    return null;
  }
  if (typeof worker.migration_tag !== 'string' || worker.migration_tag.length === 0) {
    throw new Error(
      `Cloudflare returned an invalid Durable Object migration response for Worker "${options.workerName}".`,
    );
  }
  return worker.migration_tag;
}

async function readCloudflareApiAuthentication(
  runWrangler: CloudflareCommandRunner,
): Promise<Record<string, string>> {
  const result = await runWrangler(['auth', 'token', '--json'], { capture: true });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error('Could not read the authenticated Cloudflare session.');
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cloudflare returned an invalid authentication response.');
  }
  if (!record(value)) {
    throw new Error('Cloudflare returned an invalid authentication response.');
  }
  if (
    (value.type === 'oauth' || value.type === 'api_token') &&
    typeof value.token === 'string' &&
    value.token.length > 0
  ) {
    return { Authorization: `Bearer ${value.token}` };
  }
  if (
    value.type === 'api_key' &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    typeof value.email === 'string' &&
    value.email.length > 0
  ) {
    return { 'X-Auth-Key': value.key, 'X-Auth-Email': value.email };
  }
  throw new Error('Cloudflare returned an invalid authentication response.');
}

/**
 * The Versions upload endpoint cannot safely apply a new Durable Object class migration to an
 * existing Worker in the native beta. Reject that pending lifecycle change before the caller
 * mutates a database or Worker secret; ordinary uploads whose migration tag is already active
 * continue normally.
 */
export async function assertCloudflareDurableObjectLifecycleSupported(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  accountId: string;
  apiBaseUrl: string;
  readMigrationTag?: (options: CloudflareWorkerMigrationTagOptions) => Promise<string | null>;
}): Promise<void> {
  const migrations = parseDurableObjectMigrations(
    parseRootWranglerConfig(options.configPath).migrations,
  );
  if (!migrations.some((migration) => migration.changesClasses)) {
    return;
  }
  const existing = await readCloudflareWorker(options, true);
  if (!existing) {
    return;
  }
  const readMigrationTag = options.readMigrationTag ?? readCloudflareWorkerMigrationTag;
  const migrationOptions = {
    runWrangler: options.runWrangler,
    accountId: options.accountId,
    apiBaseUrl: options.apiBaseUrl,
    workerName: options.workerName,
  };
  const activeTag = await readMigrationTag(migrationOptions);
  const after = await readCloudflareWorker(options, false);
  const afterTag = await readMigrationTag(migrationOptions);
  if (!after || after.versionId !== existing.versionId || afterTag !== activeTag) {
    throw new Error(
      'Cloudflare production or Durable Object migration state changed during verification. Retry from the current deployment.',
    );
  }
  const activeIndex =
    activeTag === null ? -1 : migrations.findIndex((migration) => migration.tag === activeTag);
  const pending = migrations.slice(activeIndex + 1).filter((migration) => migration.changesClasses);
  if (pending.length === 0) {
    return;
  }
  throw new Error(
    [
      'deploy: native Cloudflare beta cannot apply a Durable Object class migration to an existing Worker.',
      `Pending migration tag${pending.length === 1 ? '' : 's'}: ${pending.map((migration) => migration.tag).join(', ')}.`,
      'Apply the class migration through a supported Cloudflare deployment workflow, then retry after that migration tag is active.',
      'No database migration or Worker secret was changed.',
    ].join('\n'),
  );
}

function parseDurableObjectMigrations(
  value: unknown,
): Array<{ tag: string; changesClasses: boolean }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('deploy: generated Cloudflare config has a malformed migrations field.');
  }
  return value.map((migration) => {
    if (!record(migration) || typeof migration.tag !== 'string') {
      throw new Error('deploy: generated Cloudflare config has a malformed class migration.');
    }
    const fields = [
      migration.new_classes,
      migration.new_sqlite_classes,
      migration.renamed_classes,
      migration.deleted_classes,
    ];
    for (const field of fields) {
      if (field !== undefined && !Array.isArray(field)) {
        throw new Error('deploy: generated Cloudflare config has a malformed class migration.');
      }
    }
    return {
      tag: migration.tag,
      changesClasses: fields.some((field) => Array.isArray(field) && field.length > 0),
    };
  });
}

function isMissingWorkerOutput(output: string): boolean {
  return (
    /\[code:\s*10007\]/i.test(output) ||
    /no deployments|\bworker\b.*\b(?:does not exist|not found)\b/i.test(output)
  );
}

export function assertCloudflareBindingsPreserved(
  before: ExistingCloudflareWorker,
  after: ExistingCloudflareWorker,
): void {
  const sorted = (bindings: ExistingCloudflareWorker['bindings']) =>
    [...bindings].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!isDeepStrictEqual(sorted(before.bindings), sorted(after.bindings))) {
    throw new Error(
      'The uploaded version did not preserve the existing Worker bindings and variables. It has not been activated.',
    );
  }
  const handlers = (worker: ExistingCloudflareWorker): Array<string> | null => {
    const value = worker.script.handlers;
    return Array.isArray(value) &&
      value.every((handler): handler is string => typeof handler === 'string')
      ? [...new Set(value)].sort()
      : null;
  };
  if (!isDeepStrictEqual(handlers(before), handlers(after))) {
    throw new Error(
      'The uploaded version did not preserve the existing Worker event handlers. It has not been activated.',
    );
  }
}

/** Validate the supported handoff without creating or replacing resources. */
export function assertExistingCloudflareConfig(
  existing: ExistingCloudflareWorker,
  config: Record<string, unknown>,
  built = false,
): void {
  const handlers = existing.script.handlers;
  if (
    !Array.isArray(handlers) ||
    handlers.some((handler) => handler !== 'fetch' && handler !== 'scheduled')
  ) {
    throw new Error(
      'Linking an existing Worker currently supports fetch and scheduled handlers only. Queue and Durable Object handlers need a separate migration.',
    );
  }
  for (const field of [
    'durable_objects',
    'migrations',
    'exports',
    'containers',
    'workflows',
    'queues',
    'triggers',
  ]) {
    const value = config[field];
    if (hasContent(value)) {
      throw new Error(
        `The existing Worker handoff cannot change ${field}. Keep this deployment limited to the existing site.`,
      );
    }
  }
  if (
    record(existing.runtime.exports) &&
    Object.values(existing.runtime.exports).some(
      (value) => record(value) && value.type !== 'worker',
    )
  ) {
    throw new Error(
      'The existing Worker exports stateful classes. Migrate those classes separately before linking.',
    );
  }
  for (const field of ['compatibility_date', 'compatibility_flags', 'limits']) {
    const expected = existing.runtime[field] ?? (field === 'compatibility_flags' ? [] : undefined);
    const actual = config[field] ?? (field === 'compatibility_flags' ? [] : undefined);
    const equal =
      field === 'compatibility_flags'
        ? stringSetEqual(actual, expected)
        : isDeepStrictEqual(actual, expected);
    if ((built || config[field] !== undefined) && !equal) {
      throw new Error(
        `Keep the existing Worker's ${field} when linking. Update it in a later deployment.`,
      );
    }
  }
  const vars = record(config.vars) ? config.vars : {};
  const remote = new Map(existing.bindings.map((binding) => [binding.name, binding]));
  for (const [name, value] of Object.entries(vars)) {
    const binding = remote.get(name);
    const expected =
      binding?.type === 'plain_text'
        ? binding.text
        : binding?.type === 'json'
          ? binding.json
          : undefined;
    if (
      !binding ||
      !['plain_text', 'json'].includes(String(binding.type)) ||
      !isDeepStrictEqual(value, expected)
    ) {
      throw new Error(
        `Variable ${name} differs from the existing Worker. Preserve production variables and secrets when linking.`,
      );
    }
  }
  const supported: Record<string, [string, string, string]> = {
    d1: ['d1_databases', 'database_id', 'id'],
    kv_namespace: ['kv_namespaces', 'id', 'namespace_id'],
    r2_bucket: ['r2_buckets', 'bucket_name', 'bucket_name'],
    service: ['services', 'service', 'service'],
    hyperdrive: ['hyperdrive', 'id', 'id'],
  };
  const found = new Set<string>();
  for (const binding of existing.bindings) {
    if (typeof binding.name !== 'string') {
      throw new Error('Cloudflare returned a binding without a name.');
    }
    if (['plain_text', 'json', 'secret_text', 'secret_key'].includes(String(binding.type))) {
      continue;
    }
    if (binding.type === 'assets') {
      if (built && (!record(config.assets) || config.assets.binding !== binding.name)) {
        throw new Error(`Keep the existing assets binding ${binding.name} when linking.`);
      }
      continue;
    }
    const mapping = supported[String(binding.type)];
    if (!mapping) {
      throw new Error(
        `The existing binding ${binding.name} (${String(binding.type)}) is not yet supported when linking.`,
      );
    }
    const [field, localId, remoteId] = mapping;
    const entries = config[field];
    const matches = Array.isArray(entries)
      ? entries.filter((entry) => record(entry) && entry.binding === binding.name)
      : [];
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      !record(entry) ||
      typeof binding[remoteId] !== 'string' ||
      entry[localId] !== binding[remoteId] ||
      (binding.type === 'service' &&
        ((entry.environment ?? 'production') !== (binding.environment ?? 'production') ||
          entry.entrypoint !== binding.entrypoint)) ||
      (binding.type === 'r2_bucket' &&
        (entry.jurisdiction ?? 'default') !== (binding.jurisdiction ?? 'default'))
    ) {
      throw new Error(
        `Binding ${binding.name} must reference the existing Cloudflare resource when linking.`,
      );
    }
    found.add(binding.name);
  }
  for (const [field] of Object.values(supported)) {
    const entries = config[field];
    if (
      Array.isArray(entries) &&
      entries.some((entry) => !record(entry) || !found.has(String(entry.binding)))
    ) {
      throw new Error(
        `Linking cannot add or replace ${field}. Use the existing resource bindings.`,
      );
    }
  }
}

function stringSetEqual(left: unknown, right: unknown): boolean {
  if (
    !Array.isArray(left) ||
    !left.every((value): value is string => typeof value === 'string') ||
    !Array.isArray(right) ||
    !right.every((value): value is string => typeof value === 'string')
  ) {
    return false;
  }
  return isDeepStrictEqual([...new Set(left)].sort(), [...new Set(right)].sort());
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (record(value)) {
    return Object.values(value).some(hasContent);
  }
  return true;
}
