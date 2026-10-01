import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  readBuildOutput,
} from '@cloudflare/build-output-utils';
import ignore from 'ignore';
import mime from 'mime';
import { extname, join, relative } from 'pathslash';
import type { CfBuildOutput } from './cf-build-output.ts';

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`The Cloudflare ${label} is missing from the verified Worker output.`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`The Cloudflare ${label} is missing from the verified Worker output.`);
  }
  return value;
}

const moduleContentTypes: Record<string, string> = {
  esm: 'application/javascript+module',
  cjs: 'application/javascript',
  wasm: 'application/wasm',
  text: 'text/plain',
  data: 'application/octet-stream',
  json: 'text/plain',
  sourcemap: 'application/source-map',
};

function bindingsFromOutput(
  env: Json,
  workerName: string,
  activeSecrets: NonNullable<CfBuildOutput['activeSecrets']>,
  explicitSecrets: Json,
): Array<Json> {
  const inherited = new Map(activeSecrets.bindings.map((binding) => [binding.name, binding.type]));
  const names = new Set([
    ...Object.keys(env),
    ...inherited.keys(),
    ...Object.keys(explicitSecrets),
  ]);
  const bindings: Array<Json> = [];
  for (const name of names) {
    const value = object(env[name]);
    const explicit = explicitSecrets[name];
    if (explicit !== undefined) {
      if (
        typeof explicit !== 'string' ||
        inherited.get(name) === 'secret_key' ||
        (value && value.type !== 'secret')
      ) {
        throw new Error(`Cloudflare secret ${name} has an invalid explicit value or binding.`);
      }
      bindings.push({ name, type: 'secret_text', text: explicit });
      continue;
    }
    if (inherited.has(name)) {
      if (value && !['secret', 'inherit', 'unsafe:inherit'].includes(String(value.type))) {
        throw new Error(`Cloudflare secret ${name} conflicts with a Worker binding.`);
      }
      bindings.push({ name, type: 'inherit', version_id: activeSecrets.versionId });
      continue;
    }
    if (!value) {
      throw new Error(`Cloudflare binding ${name} is missing from the Worker output.`);
    }
    switch (value.type) {
      case 'text':
        bindings.push({ name, type: 'plain_text', text: textValue(value.value, name) });
        break;
      case 'json':
        bindings.push({ name, type: 'json', json: value.value });
        break;
      case 'kv':
        bindings.push({ name, type: 'kv_namespace', namespace_id: requiredString(value.id, name) });
        break;
      case 'd1':
        bindings.push({ name, type: 'd1', database_id: requiredString(value.id, name) });
        break;
      case 'r2':
        bindings.push({
          name,
          type: 'r2_bucket',
          bucket_name: requiredString(value.name, name),
          ...(value.jurisdiction ? { jurisdiction: value.jurisdiction } : {}),
        });
        break;
      case 'durable-object':
        bindings.push({
          name,
          type: 'durable_object_namespace',
          class_name: requiredString(value.exportName, name),
          ...(value.worker !== workerName
            ? { script_name: requiredString(value.worker, name) }
            : {}),
        });
        break;
      case 'assets':
        bindings.push({ name, type: 'assets' });
        break;
      case 'version-metadata':
        bindings.push({ name, type: 'version_metadata' });
        break;
      default:
        throw new Error(`Cloudflare binding ${name} cannot be uploaded with pinned secrets.`);
    }
  }
  return bindings;
}

function exportsFromOutput(exports: unknown): Json | undefined {
  if (exports === undefined) {
    return undefined;
  }
  const entries = object(exports);
  if (!entries) {
    throw new Error('Cloudflare Durable Object exports were not readable.');
  }
  const result: Json = {};
  for (const [name, raw] of Object.entries(entries)) {
    const value = object(raw);
    if (!value || value.type !== 'durable-object') {
      throw new Error(`Cloudflare export ${name} cannot be uploaded with pinned secrets.`);
    }
    if (value.state === 'deleted') {
      result[name] = { type: 'durable-object', state: 'deleted' };
    } else if (value.storage === 'sqlite' || value.storage === 'legacy-kv') {
      result[name] = { type: 'durable-object', storage: value.storage, state: 'created' };
    } else {
      throw new Error(`Cloudflare Durable Object export ${name} has no storage type.`);
    }
  }
  return result;
}

function assetConfigFromOutput(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined;
  }
  const config = object(value);
  if (!config) {
    throw new Error('Cloudflare asset configuration was not readable.');
  }
  const supported = new Set(['basePath', 'htmlHandling', 'notFoundHandling', 'runWorkerFirst']);
  if (Object.keys(config).some((key) => !supported.has(key))) {
    throw new Error('Cloudflare asset configuration has an unsupported setting.');
  }
  return {
    ...(config.basePath === undefined ? {} : { base_path: config.basePath }),
    ...(config.htmlHandling === undefined ? {} : { html_handling: config.htmlHandling }),
    ...(config.notFoundHandling === undefined
      ? {}
      : { not_found_handling: config.notFoundHandling }),
    ...(config.runWorkerFirst === undefined ? {} : { run_worker_first: config.runWorkerFirst }),
  };
}

async function apiResult(
  url: string,
  token: string,
  method: string,
  body: Json | FormData | undefined,
  verifyUploader: () => boolean,
  timeout = 120_000,
): Promise<Json> {
  if (!verifyUploader()) {
    throw new Error('The Cloudflare uploader changed during deployment.');
  }
  const form = body instanceof FormData;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  const parsed = object(await response.json());
  const result = object(parsed?.result);
  if (!response.ok || parsed?.success !== true || !result) {
    const error = Array.isArray(parsed?.errors) ? object(parsed.errors[0]) : null;
    const code = Number.isSafeInteger(error?.code) ? ` [code: ${error!.code}]` : '';
    const message = typeof error?.message === 'string' ? ` ${error.message}` : '';
    throw new Error(`Cloudflare version upload failed (${response.status})${code}.${message}`);
  }
  return result;
}

async function uploadAssets(options: {
  output: CfBuildOutput;
  accountUrl: string;
  workerName: string;
  token: string;
  verifyUploader: () => boolean;
}): Promise<string | undefined> {
  if (!options.output.assetsDirectory) {
    return undefined;
  }
  const directory = getWorkerAssetsDir(options.output.directory);
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, string>();
  const ignored = ignore().add([
    '/.assetsignore',
    '/_headers',
    '/_redirects',
    '.DS_Store',
    '.env',
    '.env.*',
    '.dev.vars',
    '.dev.vars.*',
  ]);
  const ignorePath = join(directory, '.assetsignore');
  try {
    ignored.add(readFileSync(ignorePath, 'utf8'));
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
      throw cause;
    }
  }
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('The Cloudflare asset output contains an unsupported entry.');
    }
    const path = join(entry.parentPath, entry.name);
    const relativeName = relative(directory, path).replaceAll('\\', '/');
    if (ignored.ignores(relativeName)) {
      continue;
    }
    const name = `/${relativeName}`;
    const content = readFileSync(path);
    const extension = extname(entry.name).slice(1);
    const hash = createHash('sha256')
      .update(content.toString('base64') + extension)
      .digest('hex')
      .slice(0, 32);
    manifest[name] = { hash, size: content.length };
    byHash.set(hash, path);
  }
  const session = await apiResult(
    `${options.accountUrl}/workers/scripts/${encodeURIComponent(options.workerName)}/assets-upload-session`,
    options.token,
    'POST',
    { manifest },
    options.verifyUploader,
  );
  const uploadJwt = requiredString(session.jwt, 'asset upload token');
  if (!Array.isArray(session.buckets)) {
    throw new Error('Cloudflare did not provide asset upload batches.');
  }
  if (session.buckets.length === 0) {
    return uploadJwt;
  }
  let completionJwt: string | undefined;
  for (const bucket of session.buckets) {
    if (!Array.isArray(bucket) || !bucket.every((hash) => typeof hash === 'string')) {
      throw new Error('Cloudflare returned an invalid asset upload batch.');
    }
    const form = new FormData();
    for (const hash of bucket) {
      const path = byHash.get(hash);
      if (!path) {
        throw new Error('Cloudflare requested an asset outside the verified Worker output.');
      }
      // Cloudflare stores each multipart part's MIME type on the asset. A string
      // field has no Content-Type and makes browser modules unloadable.
      form.append(
        hash,
        new File([readFileSync(path).toString('base64')], hash, {
          type: mime.getType(path) ?? 'application/null',
        }),
      );
    }
    const uploaded = await apiResult(
      `${options.accountUrl}/workers/assets/upload?base64=true`,
      uploadJwt,
      'POST',
      form,
      options.verifyUploader,
    );
    if (uploaded.jwt !== undefined) {
      completionJwt = requiredString(uploaded.jwt, 'asset completion token');
    }
  }
  return requiredString(completionJwt, 'asset completion token');
}

/** The Workers beta API is the only upload endpoint that accepts a version UUID as an inheritance source. */
export async function uploadPinnedCloudflareVersion(options: {
  output: CfBuildOutput;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  token: string;
  message?: string;
  secretsFilePath?: string;
  atomic: boolean;
  verifyUploader: () => boolean;
}): Promise<{ id: string; urls: Array<string> }> {
  const activeSecrets = options.output.activeSecrets;
  if (!activeSecrets) {
    throw new Error('The active Worker secret source was not verified.');
  }
  const built = await readBuildOutput(options.output.directory);
  const config = built.workers.default.config;
  if (
    config.name !== options.workerName ||
    !config.manifest ||
    config.manifest.type !== 'complete'
  ) {
    throw new Error('The verified Cloudflare Worker output changed before upload.');
  }
  const unsupported = Object.keys(config).filter(
    (key) =>
      !new Set([
        'name',
        'compatibilityDate',
        'compatibilityFlags',
        'assets',
        'domains',
        'observability',
        'workersDev',
        'previewUrls',
        'unsafe',
        'env',
        'exports',
        'manifest',
        'triggers',
      ]).has(key),
  );
  if (unsupported.length) {
    throw new Error(
      `Cloudflare Worker setting ${unsupported[0]} cannot be uploaded with pinned secrets.`,
    );
  }
  const unsafe = object(config.unsafe);
  const metadata = object(unsafe?.metadata);
  if (
    (unsafe && Object.keys(unsafe).some((key) => key !== 'metadata')) ||
    (metadata && Object.keys(metadata).some((key) => key !== 'keep_bindings')) ||
    (metadata?.keep_bindings !== undefined &&
      (!Array.isArray(metadata.keep_bindings) ||
        !metadata.keep_bindings.every((type) => typeof type === 'string')))
  ) {
    throw new Error('Cloudflare Worker upload metadata has an unsupported setting.');
  }
  const explicitSecrets = options.secretsFilePath
    ? object(JSON.parse(readFileSync(options.secretsFilePath, 'utf8')))
    : {};
  if (!explicitSecrets) {
    throw new Error('The explicit Cloudflare secrets file was not readable.');
  }
  const bindings = bindingsFromOutput(
    (config.env ?? {}) as Json,
    options.workerName,
    activeSecrets,
    explicitSecrets,
  );
  // The scripts uploader normally carries forward remote vars. Preserve only
  // those implicit bindings from the live version, never the inactive upload.
  const active = await apiResult(
    `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/workers/${encodeURIComponent(options.workerName)}/versions/${encodeURIComponent(activeSecrets.versionId)}`,
    options.token,
    'GET',
    undefined,
    options.verifyUploader,
  );
  if (active.id !== activeSecrets.versionId || !Array.isArray(active.bindings)) {
    throw new Error('The active Cloudflare Worker bindings could not be verified.');
  }
  const activeBindingNames = new Set<string>();
  const candidateNames = new Set(bindings.map((binding) => String(binding.name)));
  const keptTypes = new Set((metadata?.keep_bindings as Array<string> | undefined) ?? []);
  for (const entry of active.bindings) {
    const binding = object(entry);
    if (!binding || typeof binding.name !== 'string' || typeof binding.type !== 'string') {
      throw new Error('The active Cloudflare Worker bindings could not be verified.');
    }
    activeBindingNames.add(binding.name);
    if (
      !candidateNames.has(binding.name) &&
      keptTypes.has(binding.type) &&
      ['plain_text', 'json'].includes(binding.type)
    ) {
      bindings.push({
        name: binding.name,
        type: 'inherit',
        version_id: activeSecrets.versionId,
      });
      candidateNames.add(binding.name);
    }
  }
  if (activeSecrets.bindings.some(({ name }) => !activeBindingNames.has(name))) {
    throw new Error('The active Cloudflare Worker secrets changed before upload.');
  }
  const exports = exportsFromOutput(config.exports);
  const assetConfig = assetConfigFromOutput(config.assets);
  if (bindings.some((binding) => binding.type === 'assets') && !options.output.assetsDirectory) {
    throw new Error('The Cloudflare Worker has an assets binding without verified assets.');
  }
  const modules: Array<Json> = [];
  for (const [name, entry] of Object.entries(config.manifest.modules)) {
    const type = moduleContentTypes[entry.type];
    if (!type || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Cloudflare Worker module ${name} cannot be uploaded with pinned secrets.`);
    }
    modules.push({
      name,
      content_type: type,
      content_base64: readFileSync(
        join(getWorkerBundleDir(options.output.directory), name),
      ).toString('base64'),
    });
  }
  const accountUrl = `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}`;
  const jwt = await uploadAssets({
    output: options.output,
    accountUrl,
    workerName: options.workerName,
    token: options.token,
    verifyUploader: options.verifyUploader,
  });
  const uploaded = await apiResult(
    `${accountUrl}/workers/workers/${encodeURIComponent(options.workerName)}/versions${options.atomic ? '?deploy=true' : ''}`,
    options.token,
    'POST',
    {
      main_module: config.manifest.mainModule,
      modules,
      compatibility_date: config.compatibilityDate,
      compatibility_flags: config.compatibilityFlags,
      bindings,
      ...(exports ? { exports } : {}),
      ...(jwt ? { assets: { jwt, ...(assetConfig ? { config: assetConfig } : {}) } } : {}),
      annotations: { 'workers/message': options.message ?? '' },
    },
    options.verifyUploader,
  );
  return {
    id: requiredString(uploaded.id, 'Worker Version ID'),
    urls: Array.isArray(uploaded.urls)
      ? uploaded.urls.filter((url): url is string => typeof url === 'string')
      : [],
  };
}
