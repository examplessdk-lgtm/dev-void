import { isDeepStrictEqual } from 'node:util';
import type { CloudflareCommandRunner } from './execute.ts';

export type ExistingCloudflareWorker = {
  versionId: string;
  bindings: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
  script: Record<string, unknown>;
};

/** Read the deployed version, not the most recently uploaded candidate. */
export async function readExistingCloudflareWorker(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  versionId?: string;
}): Promise<ExistingCloudflareWorker> {
  const target = ['-c', options.configPath, '--env=', '--name', options.workerName];
  const read = async (args: Array<string>): Promise<Record<string, unknown>> => {
    const result = await options.runWrangler([...args, ...target, '--json'], { capture: true });
    if (result.status !== 0 || result.signal || result.error) {
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
    : await read(['deployments', 'status']);
  const versions = deployment.versions;
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
  if (!isDeepStrictEqual(deployment.versions, after.versions)) {
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
