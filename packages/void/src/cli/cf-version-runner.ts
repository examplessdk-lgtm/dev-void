import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getWorkerConfigPath, readBuildOutput } from '@cloudflare/build-output-utils';
import type {
  CloudflareCommandResult,
  CloudflareCommandRunner,
  CloudflareVersionActivationOptions,
} from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';
import type { CfBuildOutput } from './cf-build-output.ts';
import { migrateBuiltWranglerConfig } from './cf-config-migrate.ts';
import { uploadPinnedCloudflareVersion } from './cf-version-api.ts';

type CfCommand = (
  args: Array<string>,
  options: { cwd: string; capture: boolean },
) => CloudflareCommandResult | Promise<CloudflareCommandResult>;

function failed(message: string): CloudflareCommandResult {
  return { status: 1, stdout: '', stderr: message };
}

function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePositional(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('-') &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

/** Existing-Worker handoffs retain their separate link and binding checks. */
export function createActiveSecretPinner(options: {
  output: CfBuildOutput | null;
  handoffPending: boolean;
  requiredNames: ReadonlyArray<string>;
  explicitNames?: ReadonlyArray<string>;
}): CloudflareVersionActivationOptions['pinActiveSecrets'] {
  const { output } = options;
  if (!output || options.handoffPending) {
    return undefined;
  }
  return (activeVersionId, bindings) =>
    pinActiveWorkerSecrets({
      output,
      activeVersionId,
      bindings,
      requiredNames: options.requiredNames,
      explicitNames: options.explicitNames,
    });
}

/** Record the live secret source for the version-aware API uploader. */
export async function pinActiveWorkerSecrets(options: {
  output: CfBuildOutput;
  activeVersionId: string;
  bindings: ReadonlyArray<{ name: string; type: 'secret_text' | 'secret_key' }>;
  requiredNames: ReadonlyArray<string>;
  explicitNames?: ReadonlyArray<string>;
}): Promise<boolean> {
  const { activeVersionId, bindings, requiredNames, explicitNames = [] } = options;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(activeVersionId)) {
    return false;
  }
  const secretNames = new Set(bindings.map((binding) => binding.name));
  const explicit = new Set(explicitNames);
  if (
    bindings.some((binding) => !safePositional(binding.name)) ||
    secretNames.size !== bindings.length
  ) {
    return false;
  }
  if (requiredNames.some((name) => !secretNames.has(name) && !explicit.has(name))) {
    return false;
  }
  const path = getWorkerConfigPath(options.output.directory);
  const worker = parseJson(readFileSync(path, 'utf8'));
  if (!record(worker) || (worker.env !== undefined && !record(worker.env))) {
    return false;
  }
  const env = (worker.env ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(env)) {
    if (
      record(value) &&
      (value.type === 'secret' || value.type === 'inherit' || value.type === 'unsafe:inherit') &&
      !secretNames.has(name) &&
      !explicit.has(name)
    ) {
      return false;
    }
  }
  for (const { name } of bindings) {
    if (explicit.has(name)) {
      continue;
    }
    const current = env[name];
    if (
      current !== undefined &&
      (!record(current) ||
        (current.type !== 'secret' &&
          current.type !== 'inherit' &&
          current.type !== 'unsafe:inherit'))
    ) {
      return false;
    }
  }
  // The scripts upload API rejects a UUID inheritance source (10057). The
  // version-aware API accepts one, so leave cf's Build Output untouched and
  // carry the source only to that uploader.
  options.output.activeSecrets = { versionId: activeVersionId, bindings: [...bindings] };
  return true;
}

/** Prevent cf's prebuilt uploader from creating a resource as a side effect. */
export function createCfResourceVerifier(options: {
  configPath: string;
  runCf: CfCommand;
  runWrangler: CloudflareCommandRunner;
  verifyCompatibilityRunner: () => boolean;
}): (directory: string) => Promise<CloudflareCommandResult> {
  return async (directory) => {
    const worker = parseJson(readFileSync(getWorkerConfigPath(directory), 'utf8'));
    if (!record(worker) || (worker.env !== undefined && !record(worker.env))) {
      return failed('The Cloudflare Worker bindings were not readable.');
    }
    for (const [bindingName, value] of Object.entries(worker.env ?? {})) {
      if (!record(value)) {
        return failed(`Cloudflare binding ${bindingName} was not readable.`);
      }
      const identifier = (field: string) => (safePositional(value[field]) ? value[field] : null);
      if (value.type === 'kv' || value.type === 'd1' || value.type === 'flagship') {
        if (!identifier('id')) {
          return failed(
            `Cloudflare binding ${bindingName} has no ID; refusing automatic provisioning.`,
          );
        }
        continue;
      }
      if (value.type === 'queue') {
        const name = identifier('name');
        if (!name) {
          return failed(`Cloudflare Queue binding ${bindingName} has no name.`);
        }
        if (!options.verifyCompatibilityRunner()) {
          return failed('The Cloudflare resource verifier changed during deployment.');
        }
        const found = await Promise.resolve(
          options.runWrangler(['queues', 'info', name, '-c', options.configPath, '--env='], {
            capture: true,
          }),
        );
        if (
          found.status !== 0 ||
          found.signal ||
          found.error ||
          found.stdout.trim() !== `Queue Name: ${name}`
        ) {
          return failed(
            `Cloudflare Queue ${name} is unavailable; refusing automatic provisioning.`,
          );
        }
        continue;
      }
      const resource =
        value.type === 'r2'
          ? {
              kind: 'R2 bucket',
              field: 'name',
              command: ['r2', 'buckets', 'get'],
              response: 'name',
            }
          : value.type === 'dispatch-namespace'
            ? {
                kind: 'dispatch namespace',
                field: 'namespace',
                command: ['workers-for-platforms', 'dispatch-namespaces', 'get'],
                response: 'namespace_name',
              }
            : value.type === 'ai-search-namespace'
              ? {
                  kind: 'AI Search namespace',
                  field: 'namespace',
                  command: ['ai-search', 'namespace', 'get'],
                  response: 'name',
                }
              : value.type === 'agent-memory'
                ? {
                    kind: 'Agent Memory namespace',
                    field: 'namespace',
                    command: ['agent-memory', 'get-namespace'],
                    response: 'name',
                  }
                : null;
      if (!resource) {
        continue;
      }
      const name = identifier(resource.field);
      if (!name) {
        return failed(`Cloudflare ${resource.kind} binding ${bindingName} has no name.`);
      }
      const jurisdiction = value.type === 'r2' ? value.jurisdiction : undefined;
      if (jurisdiction !== undefined && !safePositional(jurisdiction)) {
        return failed(`Cloudflare R2 binding ${bindingName} has an invalid jurisdiction.`);
      }
      const result = await options.runCf(
        [
          ...resource.command,
          name,
          ...(jurisdiction ? ['--cf-r2-jurisdiction', jurisdiction] : []),
        ],
        { cwd: directory, capture: true },
      );
      const body = parseJson(result.stdout);
      if (
        result.status !== 0 ||
        result.signal ||
        result.error ||
        !record(body) ||
        body[resource.response] !== name
      ) {
        return failed(
          `Cloudflare ${resource.kind} ${name} is unavailable; refusing automatic provisioning.`,
        );
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** Run the pinned package-local cf binary with Void's existing Cloudflare session. */
export function createCfCommand(options: {
  accountId: string;
  apiBaseUrl: string;
  token?: string;
  env: (accountId: string, apiBaseUrl: string) => NodeJS.ProcessEnv;
  verifyUploader: () => boolean;
}): CfCommand {
  const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
  return async (args, run) => {
    if (!options.verifyUploader()) {
      return failed('The Cloudflare uploader changed during deployment.');
    }
    // Keep credentials in the verified CLI even if cwd resolves another cf.
    const env: NodeJS.ProcessEnv = {
      ...options.env(options.accountId, options.apiBaseUrl),
      CF_DELEGATION: '1',
      // Void owns the terminal UI. Keep cf's notices, progress, and telemetry out
      // of successful deploys; retain its complete output for error diagnosis.
      CF_QUIET: '1',
      CF_NO_OSC_PROGRESS: '1',
      CF_SEND_TELEMETRY: 'false',
    };
    if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) {
      env.NODE_USE_ENV_PROXY = '1';
    }
    if (options.token) {
      env.CLOUDFLARE_API_TOKEN = options.token;
    }
    return await new Promise<CloudflareCommandResult>((resolve) => {
      const child = spawn(process.execPath, [cf, ...args], {
        cwd: run.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Array<Buffer> = [];
      const stderr: Array<Buffer> = [];
      let bytes = 0;
      let error: string | null = null;
      // Version lists contain full Worker records. Preserve the previous 256 MiB
      // limit while letting Void's spinner animate during the network operation.
      const collect = (chunks: Array<Buffer>, chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) {
          error = 'Cloudflare command output exceeded 256 MiB.';
          child.kill();
        } else {
          chunks.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.on('error', (cause: Error) => {
        error = cause.message;
      });
      child.on('close', (status, signal) => {
        resolve({
          status: typeof status === 'number' ? status : 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          // Keep the activation protocol's provider-code parsing across CLI renderers.
          stderr: Buffer.concat(stderr)
            .toString('utf8')
            .replace(/\[(\d{4,})\]/g, '[code: $1]'),
          signal,
          error,
        });
      });
    });
  };
}

/**
 * Adapt the stable activation protocol to cf's prebuilt and API commands.
 * The protocol keeps the existing preview, inheritance, traffic and rollback checks.
 */
export function createCfVersionRunner(options: {
  output: CfBuildOutput;
  workerName: string;
  runCf: CfCommand;
  verifyResources: (directory: string) => Promise<CloudflareCommandResult>;
  pinnedUpload?: {
    accountId: string;
    apiBaseUrl: string;
    getToken: () => Promise<string | null>;
    verifyUploader: () => boolean;
  };
}): CloudflareCommandRunner {
  const { output, workerName, runCf } = options;
  const run = async (args: Array<string>, capture: boolean, cwd = output.directory) =>
    await runCf(args, { cwd, capture });
  const verifyResources = async (directory: string) => {
    try {
      return await options.verifyResources(directory);
    } catch {
      return failed('Cloudflare resources could not be verified before upload.');
    }
  };

  const uploadPinnedVersion = async (args: Array<string>, atomic: boolean) => {
    if (!options.pinnedUpload || !options.pinnedUpload.verifyUploader()) {
      return failed('The version-aware Cloudflare uploader is unavailable.');
    }
    const token = await options.pinnedUpload.getToken();
    if (!token) {
      return failed('Cloudflare session has no bearer for version-aware upload.');
    }
    try {
      const version = await uploadPinnedCloudflareVersion({
        output,
        accountId: options.pinnedUpload.accountId,
        apiBaseUrl: options.pinnedUpload.apiBaseUrl,
        workerName,
        token,
        ...(flag(args, '--message') ? { message: flag(args, '--message') } : {}),
        ...(flag(args, '--secrets-file') ? { secretsFilePath: flag(args, '--secrets-file') } : {}),
        atomic,
        verifyUploader: options.pinnedUpload.verifyUploader,
      });
      const preview = version.urls.find((url) => /^https:\/\//.test(url));
      return {
        status: 0,
        stdout: `Worker Version ID: ${version.id}\n${preview ? `Version Preview URL: ${preview}\n` : ''}`,
        stderr: '',
      };
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : 'Cloudflare version upload failed.');
    }
  };

  return async (args, command) => {
    if (args[0] === 'deployments' && args[1] === 'status') {
      const result = await run(['workers', 'deployments', 'list', '--worker', workerName], true);
      if (result.status !== 0) {
        return result;
      }
      const body = parseJson(result.stdout);
      const deployments = record(body) ? body.deployments : undefined;
      if (Array.isArray(deployments) && deployments.length === 0) {
        return failed('The Cloudflare Worker has no deployments.');
      }
      if (!Array.isArray(deployments) || !record(deployments[0])) {
        return failed('The Cloudflare Worker deployment was not readable.');
      }
      return { ...result, stdout: JSON.stringify(deployments[0]) };
    }

    if (args[0] === 'versions' && args[1] === 'list') {
      const pageSize = 10;
      const readPage = async (page: number) => {
        const result = await run(
          [
            'workers',
            'versions',
            'list',
            '--worker-id',
            workerName,
            '--per-page',
            String(pageSize),
            '--page',
            String(page),
          ],
          true,
        );
        const body = parseJson(result.stdout);
        return {
          result,
          versions:
            Array.isArray(body) &&
            body.length <= pageSize &&
            body.every(
              (item) =>
                record(item) && typeof item.id === 'string' && Number.isSafeInteger(item.number),
            ) &&
            new Set(body.map((item) => item.number)).size === body.length
              ? body
              : null,
        };
      };
      const first = await readPage(1);
      if (first.result.status !== 0) {
        return first.result;
      }
      if (!first.versions) {
        return failed('The Cloudflare Worker version list was not readable.');
      }
      const versions = [...first.versions];
      if (versions.length === pageSize) {
        const second = await readPage(2);
        if (second.result.status !== 0 || !second.versions) {
          return failed('The Cloudflare Worker version history was not readable.');
        }
        if (second.versions.length > 0) {
          const firstNumbers = versions.map((item) => item.number as number);
          const secondNumbers = second.versions.map((item) => item.number as number);
          if (Math.min(...secondNumbers) > Math.max(...firstNumbers)) {
            versions.push(...second.versions);
            let last = Math.max(...secondNumbers);
            for (let page = 3; page <= 1000 && second.versions.length === pageSize; page++) {
              const next = await readPage(page);
              if (next.result.status !== 0 || !next.versions) {
                return failed('The Cloudflare Worker version history was not readable.');
              }
              if (next.versions.length === 0) {
                break;
              }
              const numbers = next.versions.map((item) => item.number as number);
              if (Math.min(...numbers) <= last) {
                return failed('The Cloudflare Worker version history changed during inspection.');
              }
              versions.push(...next.versions);
              last = Math.max(...numbers);
              if (next.versions.length < pageSize) {
                break;
              }
              if (page === 1000) {
                return failed('The Cloudflare Worker version history is too large to verify.');
              }
            }
          } else if (Math.max(...secondNumbers) >= Math.min(...firstNumbers)) {
            return failed('The Cloudflare Worker version history changed during inspection.');
          }
        }
      }
      return {
        ...first.result,
        stdout: JSON.stringify(
          versions.sort((a, b) => (a.number as number) - (b.number as number)).slice(-10),
        ),
      };
    }

    if (args[0] === 'versions' && args[1] === 'view' && args[2]) {
      const result = await run(
        ['workers', 'versions', 'get', args[2], '--worker-id', workerName],
        true,
      );
      if (result.status !== 0) {
        return result;
      }
      const version = parseJson(result.stdout);
      if (!record(version) || version.id !== args[2] || !Array.isArray(version.bindings)) {
        return failed('The Cloudflare Worker version was not readable.');
      }
      return {
        ...result,
        stdout: JSON.stringify({ ...version, resources: { bindings: version.bindings } }),
      };
    }

    if (args[0] === 'versions' && args[1] === 'upload') {
      if (
        flag(args, '--name') !== workerName ||
        (args.includes('--assets') && flag(args, '--assets') !== output.assetsDirectory)
      ) {
        return failed('The Cloudflare version upload target changed.');
      }
      const verified = await verifyResources(output.directory);
      if (verified.status !== 0 || verified.signal || verified.error) {
        return verified;
      }
      if (output.activeSecrets) {
        return uploadPinnedVersion(args, false);
      }
      return run(
        [
          'workers',
          'versions',
          'create',
          '--prebuilt',
          ...(flag(args, '--message') ? ['--message', flag(args, '--message')!] : []),
          ...(flag(args, '--secrets-file')
            ? ['--secrets-file', flag(args, '--secrets-file')!]
            : []),
          ...(flag(args, '--preview-alias')
            ? ['--preview-alias', flag(args, '--preview-alias')!]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'versions' && args[1] === 'deploy') {
      if (flag(args, '--name') !== workerName) {
        return failed('The Cloudflare deployment target changed.');
      }
      const flagsStart = args.findIndex((item, index) => index >= 2 && item.startsWith('-'));
      const versions = args.slice(2, flagsStart < 0 ? undefined : flagsStart);
      if (!versions.every((item) => /^[0-9a-f-]{36}@\d+(?:\.\d+)?$/i.test(item))) {
        return failed('The Cloudflare deployment versions were invalid.');
      }
      const parsed = versions.map((item) => {
        const [version_id, percentage] = item.split('@');
        return { version_id, percentage: Number(percentage) };
      });
      if (
        parsed.length === 0 ||
        new Set(parsed.map((item) => item.version_id)).size !== parsed.length ||
        parsed.some((item) => item.percentage < 0 || item.percentage > 100) ||
        Math.abs(parsed.reduce((sum, item) => sum + item.percentage, 0) - 100) > 0.001
      ) {
        return failed('The Cloudflare deployment percentages were invalid.');
      }
      return run(
        [
          'workers',
          'deployments',
          'create',
          '--worker',
          workerName,
          '--strategy',
          'percentage',
          '--versions',
          JSON.stringify(parsed),
          ...(flag(args, '--message')
            ? [
                '--body',
                JSON.stringify({
                  strategy: 'percentage',
                  versions: parsed,
                  annotations: { 'workers/message': flag(args, '--message') },
                }),
              ]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'deploy') {
      if (
        flag(args, '--name') !== workerName ||
        (args.includes('--assets') && flag(args, '--assets') !== output.assetsDirectory)
      ) {
        return failed('The Cloudflare bootstrap target changed.');
      }
      const verified = await verifyResources(output.directory);
      if (verified.status !== 0 || verified.signal || verified.error) {
        return verified;
      }
      if (output.activeSecrets) {
        return uploadPinnedVersion(args, true);
      }
      return run(
        [
          'deploy',
          '--prebuilt',
          ...(flag(args, '--message') ? ['--message', flag(args, '--message')!] : []),
          ...(flag(args, '--secrets-file')
            ? ['--secrets-file', flag(args, '--secrets-file')!]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'triggers' && args[1] === 'deploy') {
      const configPath = flag(args, '-c');
      if (!configPath || flag(args, '--name') !== workerName) {
        return failed('The Cloudflare trigger target changed.');
      }
      const raw = parseJson(readFileSync(configPath, 'utf8'));
      if (!record(raw) || raw.name !== workerName) {
        return failed('The Cloudflare trigger snapshot was not readable.');
      }
      const directory = mkdtempSync(join(tmpdir(), 'void-cf-triggers-'));
      try {
        cpSync(join(output.directory, '.cloudflare'), join(directory, '.cloudflare'), {
          recursive: true,
        });
        const workerPath = getWorkerConfigPath(directory);
        const worker = parseJson(readFileSync(workerPath, 'utf8'));
        if (!record(worker)) {
          return failed('The private Cloudflare Worker config was not readable.');
        }
        const migrated = migrateBuiltWranglerConfig({
          ...raw,
          compatibility_date: worker.compatibilityDate,
        }).worker;
        if (!migrated) {
          return failed('The Cloudflare trigger snapshot was not convertible.');
        }
        const next = migrated.triggers ?? [];
        const previous = Array.isArray(worker.triggers) ? worker.triggers : [];
        const preserveRoutes = raw.routes === undefined && raw.route === undefined;
        const preserveEmail = raw.addresses === undefined;
        worker.triggers = [
          ...next,
          ...(preserveRoutes
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'fetch')
            : []),
          ...(preserveEmail
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'email')
            : []),
        ];
        // Workflow schedules and settings live on exports, outside `triggers`.
        // Replay the snapshot even during compensation or removal, when the
        // candidate's workflow declarations describe the version being left.
        for (const field of ['env', 'exports'] as const) {
          const previous = record(worker[field]) ? worker[field] : {};
          worker[field] = {
            ...Object.fromEntries(
              Object.entries(previous).filter(
                ([, value]) => !record(value) || value.type !== 'workflow',
              ),
            ),
            ...migrated[field],
          };
        }
        if (!preserveRoutes) {
          worker.domains = migrated.domains ?? [];
        }
        if (typeof raw.workers_dev === 'boolean') {
          worker.workersDev = raw.workers_dev;
        }
        if (typeof raw.preview_urls === 'boolean') {
          worker.previewUrls = raw.preview_urls;
        }
        writeFileSync(workerPath, JSON.stringify(worker), { mode: 0o600 });
        await readBuildOutput(directory);
        const verified = await verifyResources(directory);
        if (verified.status !== 0 || verified.signal || verified.error) {
          return verified;
        }
        return await run(
          ['workers', 'triggers', 'deploy', '--prebuilt'],
          command.capture,
          directory,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    if (args[0] === 'queues' && args[1] === 'consumer' && args[2] === 'remove') {
      const queueName = args[3];
      if (!queueName || args[4] !== workerName) {
        return failed('The Cloudflare Queue consumer target changed.');
      }
      const queues = await run(['queues', 'list'], true);
      if (queues.status !== 0) {
        return queues;
      }
      const allQueues = parseJson(queues.stdout);
      if (!Array.isArray(allQueues)) {
        return failed('The Cloudflare Queue list was not readable.');
      }
      const queue = allQueues.find((item) => record(item) && item.queue_name === queueName);
      if (!record(queue) || typeof queue.queue_id !== 'string') {
        return failed(`Cloudflare Queue ${queueName} was not found.`);
      }
      const consumers = await run(
        ['queues', 'consumers', 'list', '--queue-id', queue.queue_id],
        true,
      );
      if (consumers.status !== 0) {
        return consumers;
      }
      const allConsumers = parseJson(consumers.stdout);
      if (!Array.isArray(allConsumers)) {
        return failed('The Cloudflare Queue consumers were not readable.');
      }
      const matching = allConsumers.filter((item) => record(item) && item.script === workerName);
      if (matching.length === 0) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        matching.length !== 1 ||
        !record(matching[0]) ||
        typeof matching[0].consumer_id !== 'string'
      ) {
        return failed('The Cloudflare Queue consumer identity was ambiguous.');
      }
      return run(
        [
          'queues',
          'consumers',
          'delete',
          matching[0].consumer_id,
          '--queue-id',
          queue.queue_id,
          '--force',
        ],
        command.capture,
      );
    }

    return failed(`Unsupported Cloudflare activation operation: ${args[0] ?? ''} ${args[1] ?? ''}`);
  };
}
