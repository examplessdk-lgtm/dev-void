#!/usr/bin/env node
/**
 * Private transport for the existing Void Cloudflare command seams. The
 * orchestrators still use their established argument/result contracts; this
 * process translates them to the pinned cf CLI. It never invokes Wrangler.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { parse } from 'jsonc-parser';
import { dirname, join, resolve } from 'pathslash';
import { EnvHttpProxyAgent, fetch as httpFetch } from 'undici';
import { prepareCfBuildOutput } from './cf-build-output.ts';
import { persistCfKeyringPreference, readCfSessionCredential } from './cf-session.ts';

type Result = { status: number; stdout: string; stderr: string };
type Json = Record<string, unknown>;

const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
const args = process.argv.slice(2);
// This dedicated transport process uses the same encrypted OAuth store for
// login, deployment, and ancillary API calls. API-token overrides still win.
process.env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';

function cfEnvironment(): NodeJS.ProcessEnv {
  // The pinned bin otherwise delegates to any cf installed by the project.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CF_DELEGATION: '1',
    CF_SEND_TELEMETRY: 'false',
    CF_NO_OSC_PROGRESS: '1',
  };
  // cf uses Node's built-in fetch for API operations. Node does not consult
  // HTTP(S)_PROXY for fetch unless its environment proxy support is enabled.
  // Match the proxy handling of our direct API reads below.
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) {
    env.NODE_USE_ENV_PROXY = '1';
  }
  for (const [canonical, alias] of [
    ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
    ['CLOUDFLARE_API_KEY', 'CF_API_KEY'],
    ['CLOUDFLARE_EMAIL', 'CF_EMAIL'],
    ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'],
  ]) {
    if (!env[canonical] && env[alias]) {
      env[canonical] = env[alias];
    }
  }
  return env;
}

function result(status: number, stdout = '', stderr = ''): Result {
  return { status, stdout, stderr };
}

function runCf(command: Array<string>, cwd = process.cwd()): Result {
  const env = cfEnvironment();
  env.CF_QUIET = '1';
  const child = spawnSync(process.execPath, [cf, ...command], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = (child.stderr || child.error?.message || '').replace(
    /\[(\d{4,})\]/g,
    '[code: $1]',
  );
  return result(child.status ?? 1, child.stdout ?? '', stderr);
}

function runInteractiveCf(command: Array<string>): Result {
  const child = spawnSync(process.execPath, [cf, ...command, '--quiet'], {
    cwd: process.cwd(),
    // cf's global quiet flag hides its banner; OAuth's browser URL and device
    // code are still printed by the login handler for the user to verify.
    env: { ...cfEnvironment(), CF_QUIET: '1' },
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  return result(child.status ?? 1, '', child.error?.message ?? '');
}

async function withBuildOutput(
  raw: Json,
  sourceMain: string | null,
  action: (directory: string) => Result,
): Promise<Result> {
  const scratch = mkdtempSync(join(tmpdir(), 'void-cf-command-'));
  try {
    const main = 'index.js';
    if (sourceMain) {
      copyFileSync(sourceMain, join(scratch, main));
    } else {
      writeFileSync(
        join(scratch, main),
        'export default { fetch() { return new Response(""); } };\n',
      );
    }
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({ ...raw, main, compatibility_date: raw.compatibility_date ?? '2025-01-01' }),
      { mode: 0o600 },
    );
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? raw.account_id;
    if (typeof accountId !== 'string' || !accountId) {
      throw new Error('Cloudflare account is not pinned for Worker deployment.');
    }
    const output = await prepareCfBuildOutput(scratch, accountId);
    if (!output) {
      throw new Error('Could not prepare the Cloudflare Worker build output.');
    }
    try {
      await assertExistingProvisionableResources(output.directory, accountId);
      return action(output.directory);
    } finally {
      output.dispose();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parsedJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloudflare returned an unexpected response.');
  }
  return value as Json;
}

function field(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configPath(): string | undefined {
  return field('-c') ?? field('--config');
}

function config(): Json {
  const path = configPath();
  if (!path) {
    throw new Error('Cloudflare config path is required for this operation.');
  }
  return object(parse(readFileSync(path, 'utf8')));
}

function workerName(): string {
  const name = field('--name') ?? config().name;
  if (typeof name !== 'string' || !name) {
    throw new Error('Cloudflare Worker name is missing from the generated config.');
  }
  return name;
}

function updateBinding(section: string, binding: string, values: Json): void {
  const path = configPath();
  if (!path || !binding) {
    throw new Error('Cloudflare resource binding and config are required.');
  }
  const current = config();
  const previous = Array.isArray(current[section]) ? current[section] : [];
  const existing = previous.map(object).find((entry) => entry.binding === binding);
  current[section] = [
    ...previous.filter((entry) => object(entry).binding !== binding),
    { ...existing, binding, ...values },
  ];
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

function d1Database(token: string): { id: string; dir: string; table: string; pattern?: string } {
  const entries = config().d1_databases;
  if (!Array.isArray(entries)) {
    throw new Error('D1 database binding is unavailable.');
  }
  const selected = entries
    .map(object)
    .find(
      (entry) =>
        entry.database_id === token || entry.database_name === token || entry.binding === token,
    );
  if (!selected || typeof selected.database_id !== 'string') {
    throw new Error('D1 database binding is unavailable.');
  }
  return {
    id: selected.database_id,
    dir: typeof selected.migrations_dir === 'string' ? selected.migrations_dir : './migrations',
    ...(typeof selected.migrations_pattern === 'string'
      ? { pattern: selected.migrations_pattern }
      : {}),
    table:
      typeof selected.migrations_table === 'string' ? selected.migrations_table : 'd1_migrations',
  };
}

function cleanJson(command: Array<string>, transform?: (value: unknown) => unknown): Result {
  const called = runCf(command);
  if (called.status !== 0 || !transform) {
    return called;
  }
  return result(0, `${JSON.stringify(transform(parsedJson(called.stdout)))}\n`, called.stderr);
}

function accountId(): string {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config().account_id;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Cloudflare account is not pinned for API inspection.');
  }
  return accountId;
}

async function cloudflareApiGet(
  path: string,
  failure: string,
  extraHeaders: Record<string, string> = {},
): Promise<Json> {
  const base = process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4';
  const url = `${base.replace(/\/$/, '')}${path}`;
  const proxy =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
      ? new EnvHttpProxyAgent()
      : null;
  try {
    const response = await httpFetch(url, {
      headers: { ...apiHeaders(), ...extraHeaders },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      ...(proxy ? { dispatcher: proxy } : {}),
    });
    const body = object(await response.json());
    if (!response.ok || body.success !== true) {
      throw new Error(failure);
    }
    return body;
  } finally {
    await proxy?.close();
  }
}

async function clearWorkerCronSchedules(worker: string): Promise<Result> {
  const base = (
    process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4'
  ).replace(/\/$/, '');
  const endpoint = `${base}/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/schedules`;
  const proxy =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
      ? new EnvHttpProxyAgent()
      : null;
  try {
    const response = await httpFetch(endpoint, {
      method: 'PUT',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: '[]',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      ...(proxy ? { dispatcher: proxy } : {}),
    });
    const body = object(await response.json());
    const schedules = object(body.result).schedules;
    if (
      !response.ok ||
      body.success !== true ||
      !Array.isArray(schedules) ||
      schedules.length !== 0
    ) {
      throw new Error(
        `Cloudflare did not clear the Worker Cron Triggers (HTTP ${response.status}).`,
      );
    }
    return result(0);
  } finally {
    await proxy?.close();
  }
}

async function clearWorkerCustomDomains(worker: string): Promise<Result> {
  const base = (
    process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4'
  ).replace(/\/$/, '');
  const endpoint = `${base}/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/domains/records`;
  const proxy =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
      ? new EnvHttpProxyAgent()
      : null;
  try {
    const response = await httpFetch(endpoint, {
      method: 'PUT',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        override_scope: true,
        override_existing_origin: false,
        override_existing_dns_record: false,
        origins: [],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      ...(proxy ? { dispatcher: proxy } : {}),
    });
    const body = object(await response.json());
    if (!response.ok || body.success !== true) {
      throw new Error(`Cloudflare rejected the empty custom-domain set (HTTP ${response.status}).`);
    }
    return result(0);
  } finally {
    await proxy?.close();
  }
}

async function assertExistingProvisionableResources(
  directory: string,
  account: string,
): Promise<void> {
  // cf 1.0.0-beta.5 turns on Wrangler's automatic provisioning for every
  // prebuilt upload, with no exposed flag to turn it off. A named R2 bucket,
  // Queue, or dispatch namespace may otherwise be created during an upload.
  const built = await readBuildOutput(directory);
  const bindings = built.workers.default.config.env ?? {};
  const queueNames = new Set<string>();
  const accountPath = `/accounts/${encodeURIComponent(account)}`;
  for (const [bindingName, value] of Object.entries(bindings)) {
    const binding = object(value);
    const identifier = (key: string): string => {
      const id = binding[key];
      if (typeof id !== 'string' || !id) {
        throw new Error(
          `Cloudflare binding ${bindingName} has no ${key}; refusing automatic provisioning.`,
        );
      }
      return id;
    };
    if (binding.type === 'kv' || binding.type === 'd1') {
      identifier('id');
    } else if (binding.type === 'r2') {
      const name = identifier('name');
      const jurisdiction = binding.jurisdiction;
      if (jurisdiction !== undefined && typeof jurisdiction !== 'string') {
        throw new Error(`Cloudflare R2 binding ${bindingName} has an invalid jurisdiction.`);
      }
      await cloudflareApiGet(
        `${accountPath}/r2/buckets/${encodeURIComponent(name)}`,
        `Cloudflare R2 bucket ${name} is unavailable; refusing automatic provisioning.`,
        jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {},
      );
    } else if (binding.type === 'queue') {
      queueNames.add(identifier('name'));
    } else if (binding.type === 'dispatch-namespace') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/workers/dispatch/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare dispatch namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'ai-search-namespace') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/ai-search/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare AI Search namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'agent-memory') {
      const name = identifier('namespace');
      await cloudflareApiGet(
        `${accountPath}/agent-memory/namespaces/${encodeURIComponent(name)}`,
        `Cloudflare Agent Memory namespace ${name} is unavailable; refusing automatic provisioning.`,
      );
    } else if (binding.type === 'flagship') {
      identifier('id');
    }
  }
  if (queueNames.size > 0) {
    const existing = new Set((await readAllQueues()).map((queue) => queue.queue_name));
    for (const name of queueNames) {
      if (!existing.has(name)) {
        throw new Error(
          `Cloudflare Queue ${name} is unavailable; refusing automatic provisioning.`,
        );
      }
    }
  }
}

async function readVersionResources(worker: string, versionId: string): Promise<Json> {
  const body = await cloudflareApiGet(
    `/accounts/${encodeURIComponent(accountId())}/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`,
    'Cloudflare did not return Worker version resources.',
  );
  const resources = object(object(body.result).resources);
  if (!Array.isArray(resources.bindings) || !resources.script || !resources.script_runtime) {
    throw new Error('Cloudflare Worker version resources were incomplete.');
  }
  return resources;
}

function apiHeaders(): Record<string, string> {
  const key = process.env.CLOUDFLARE_API_KEY ?? process.env.CF_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL ?? process.env.CF_EMAIL;
  if (key && email) {
    return { 'X-Auth-Key': key, 'X-Auth-Email': email };
  }
  const credential = sessionCredential();
  if (!credential) {
    throw new Error('Cloudflare session bearer is unavailable.');
  }
  return { Authorization: `Bearer ${credential.token}` };
}

async function withSecretFile(
  content: string,
  action: (path: string) => Result | Promise<Result>,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-secret-'));
  try {
    const path = join(directory, 'body.json');
    writeFileSync(path, content, { mode: 0o600 });
    return await action(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sessionCredential(): { type: 'oauth' | 'api_token'; token: string } | null {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (token) {
    return { type: 'api_token', token };
  }
  const identity = runCf(['auth', 'whoami']);
  if (identity.status !== 0) {
    return null;
  }
  const state = object(parsedJson(identity.stdout));
  if (state.authenticated !== true || state.tokenValid !== true) {
    return null;
  }
  const credential = readCfSessionCredential(process.cwd(), state);
  return credential ? { type: 'oauth', token: credential } : null;
}

function auth(): Result {
  if (args[0] === 'login') {
    const loggedIn = runInteractiveCf(['auth', 'login', '--force']);
    if (loggedIn.status === 0) {
      persistCfKeyringPreference(process.cwd());
    }
    return loggedIn;
  }
  if (args[0] === 'logout') {
    return runCf(['auth', 'logout']);
  }
  if (args[0] === 'whoami') {
    const called = runCf(['auth', 'whoami']);
    if (called.status !== 0) {
      return called;
    }
    const identity = object(parsedJson(called.stdout));
    if (identity.authenticated !== true || identity.tokenValid !== true) {
      return result(
        1,
        JSON.stringify({ loggedIn: false }),
        'Cloudflare authentication is required.',
      );
    }
    if (String(identity.authSource).startsWith('OAuth token from ')) {
      persistCfKeyringPreference(process.cwd());
    }
    return result(
      0,
      JSON.stringify({
        loggedIn: true,
        accounts: identity.accounts,
        email: identity.email,
        tokenPermissions: identity.scopes,
        authType:
          process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY
            ? 'Global API Key'
            : String(identity.authSource).startsWith('OAuth token')
              ? 'OAuth Token'
              : 'API Token',
      }),
      called.stderr,
    );
  }
  if (args[0] === 'auth' && args[1] === 'token') {
    const credential = sessionCredential();
    return credential
      ? result(0, `${JSON.stringify(credential)}\n`)
      : result(1, '', 'Cloudflare session has no OAuth bearer.');
  }
  return result(1, '', 'Unsupported Cloudflare authentication operation.');
}

function listAllResourcePages(command: Array<string>, extraFlags: Array<string> = []): Result {
  const pageSize = 100;
  const entries: Array<unknown> = [];
  for (let page = 1; page <= 100; page++) {
    const listed = runCf([
      ...command,
      '--page',
      String(page),
      '--per-page',
      String(pageSize),
      ...extraFlags,
    ]);
    if (listed.status !== 0) {
      return listed;
    }
    const items = parsedJson(listed.stdout);
    if (!Array.isArray(items) || items.length > pageSize) {
      throw new Error(`Cloudflare returned an invalid ${command.join(' ')} page.`);
    }
    entries.push(...items);
    if (items.length < pageSize) {
      return result(0, `${JSON.stringify(entries)}\n`);
    }
  }
  throw new Error(`Cloudflare ${command.join(' ')} exceeded the supported page limit.`);
}

async function readAllQueues(): Promise<Array<Json>> {
  // cf queues list has no page option, so read the API's paginated response directly.
  const queues: Array<Json> = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const body = await cloudflareApiGet(
      `/accounts/${encodeURIComponent(accountId())}/queues?page=${page}`,
      'Cloudflare did not return the Queue list.',
    );
    const entries = body.result;
    const info = object(body.result_info);
    if (
      !Array.isArray(entries) ||
      !Number.isSafeInteger(info.page) ||
      info.page !== page ||
      !Number.isSafeInteger(info.total_pages) ||
      (info.total_pages as number) < 0 ||
      (info.total_pages as number) > 1000
    ) {
      throw new Error('Cloudflare returned incomplete Queue pagination.');
    }
    for (const entry of entries) {
      const queue = object(entry);
      if (
        typeof queue.queue_id !== 'string' ||
        typeof queue.queue_name !== 'string' ||
        seen.has(queue.queue_id)
      ) {
        throw new Error('Cloudflare returned an invalid Queue list.');
      }
      seen.add(queue.queue_id);
      queues.push(queue);
    }
    if (page >= (info.total_pages as number)) {
      return queues;
    }
  }
  throw new Error('Cloudflare Queue list exceeded the supported page limit.');
}

async function resources(): Promise<Result> {
  const [group, verb, third] = args;
  if (group === 'd1' && verb === 'execute' && third) {
    const database = d1Database(third);
    const sql = field('--command');
    if (!sql) {
      throw new Error('D1 SQL command is missing.');
    }
    return runCf(['d1', 'query', database.id, '--sql', sql]);
  }
  if (group === 'd1' && verb === 'migrations' && (third === 'list' || third === 'apply')) {
    const token = args[3];
    if (!token) {
      throw new Error('D1 migration target is missing.');
    }
    const database = d1Database(token);
    const called = runCf([
      'd1',
      'migrations',
      third,
      database.id,
      '--dir',
      database.dir,
      ...(database.pattern ? ['--pattern', database.pattern] : []),
      '--table',
      database.table,
    ]);
    if (called.status !== 0 || third !== 'list') {
      return called;
    }
    const pending = parsedJson(called.stdout);
    if (!Array.isArray(pending)) {
      throw new Error('D1 migration list was malformed.');
    }
    return result(
      0,
      pending.length
        ? `Migrations to be applied:\n${pending.map((item) => object(item).Name).join('\n')}\n`
        : 'No migrations to apply!\n',
    );
  }
  if (group === 'containers' && verb === 'list') {
    return runCf(['containers', 'applications', 'list']);
  }
  if (group === 'd1' && verb === 'list') {
    return listAllResourcePages(['d1', 'list']);
  }
  if (group === 'd1' && verb === 'info' && third) {
    const listed = listAllResourcePages(['d1', 'list']);
    if (listed.status !== 0) {
      return listed;
    }
    const value = parsedJson(listed.stdout);
    if (!Array.isArray(value)) {
      throw new Error('D1 list was malformed.');
    }
    const selected = value.find((item) => object(item).name === third) ?? null;
    return selected === null
      ? result(1, '', `D1 database ${JSON.stringify(third)} does not exist.`)
      : result(0, `${JSON.stringify(selected)}\n`);
  }
  if (group === 'd1' && verb === 'create' && third) {
    const created = runCf(['d1', 'create', '--name', third]);
    if (created.status !== 0) {
      return created;
    }
    const database = object(parsedJson(created.stdout));
    if (typeof database.uuid !== 'string') {
      throw new Error('D1 creation returned no database ID.');
    }
    updateBinding('d1_databases', field('--binding') ?? '', {
      database_name: third,
      database_id: database.uuid,
    });
    return created;
  }
  if (group === 'kv' && verb === 'namespace' && third === 'list') {
    return listAllResourcePages(
      ['kv', 'namespaces', 'list'],
      ['--order', 'id', '--direction', 'asc'],
    );
  }
  if (group === 'kv' && verb === 'namespace' && third === 'create' && args[3]) {
    const created = runCf(['kv', 'namespaces', 'create', '--title', args[3]]);
    if (created.status !== 0) {
      return created;
    }
    const namespace = object(parsedJson(created.stdout));
    if (typeof namespace.id !== 'string') {
      throw new Error('KV creation returned no namespace ID.');
    }
    updateBinding('kv_namespaces', field('--binding') ?? '', { id: namespace.id });
    return created;
  }
  if (group === 'r2' && verb === 'bucket' && third === 'info' && args[3]) {
    const read = runCf(['r2', 'buckets', 'get', args[3]]);
    return read.status !== 0 && /\[code:\s*10006\]/.test(read.stderr)
      ? result(1, '', '[code: 10006] The specified bucket does not exist.')
      : read;
  }
  if (group === 'r2' && verb === 'bucket' && third === 'create' && args[3]) {
    const created = runCf(['r2', 'buckets', 'create', '--name', args[3]]);
    if (created.status === 0) {
      updateBinding('r2_buckets', field('--binding') ?? '', { bucket_name: args[3] });
    }
    return created;
  }
  if (group === 'hyperdrive' && verb === 'create' && third) {
    const connection = args.find((part) => part.startsWith('--connection-string='))?.slice(20);
    if (!connection) {
      throw new Error('Hyperdrive connection string is missing.');
    }
    const url = new URL(connection);
    const created = await withSecretFile(
      JSON.stringify({
        name: third,
        origin: {
          host: url.hostname,
          port: Number(url.port || (url.protocol.startsWith('mysql') ? 3306 : 5432)),
          database: decodeURIComponent(url.pathname.replace(/^\//, '')),
          scheme: url.protocol.replace(':', ''),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
      }),
      (path) => runCf(['hyperdrive', 'create', '--body', `@${path}`]),
    );
    if (created.status !== 0) {
      return result(created.status, '', 'Hyperdrive creation failed.');
    }
    const hyperdrive = object(parsedJson(created.stdout));
    if (typeof hyperdrive.id !== 'string') {
      throw new Error('Hyperdrive creation returned no ID.');
    }
    updateBinding('hyperdrive', field('--binding') ?? '', { id: hyperdrive.id });
    return result(0, `${JSON.stringify({ id: hyperdrive.id, name: third })}\n`);
  }
  if (group === 'queues' && (verb === 'info' || verb === 'create') && third) {
    if (verb === 'create') {
      return runCf(['queues', 'create', '--queue-name', third]);
    }
    const queue = (await readAllQueues()).find((item) => item.queue_name === third);
    return queue
      ? result(0, `Queue Name: ${third}\n`)
      : result(1, '', `Queue "${third}" does not exist`);
  }
  return result(1, '', `Unsupported Cloudflare resource operation: ${group} ${verb}.`);
}

function emailZone(domain: string): string {
  const labels = domain.split('.');
  for (let offset = 0; offset <= labels.length - 2; offset++) {
    const candidate = labels.slice(offset).join('.');
    const read = runCf(['email-routing', 'settings', 'get', '--zone', candidate]);
    if (read.status === 0) {
      return candidate;
    }
    if (!/Zone not found:/.test(read.stderr)) {
      throw new Error('Cloudflare could not resolve the Email zone.');
    }
  }
  throw new Error(`Cloudflare Email zone for ${domain} was not found.`);
}

function email(): Result {
  const [group, product, operation, candidate] = args;
  if (group !== 'email' || !candidate) {
    return result(1, '', 'Unsupported Cloudflare email operation.');
  }
  if (product === 'routing' && operation === 'settings') {
    const read = runCf(['email-routing', 'settings', 'get', '--zone', candidate]);
    if (read.status !== 0) {
      return /Zone not found:/.test(read.stderr)
        ? result(1, '', `Could not find a zone for \`${candidate}\`.`)
        : read;
    }
    const settings = object(parsedJson(read.stdout));
    if (typeof settings.tag !== 'string' || typeof settings.name !== 'string') {
      throw new Error('Email Routing settings were incomplete.');
    }
    return result(
      0,
      `Email Routing for ${settings.name}:\n  Enabled: ${settings.enabled === true}\n  Status: ${settings.status}\n  Tag: ${settings.tag}\n`,
    );
  }
  if (product === 'routing' && operation === 'enable') {
    return runCf(['email-routing', 'enable', '--zone', candidate, '--name', candidate]);
  }
  if (product === 'routing' && operation === 'rules' && args[3] === 'list' && args[4]) {
    const zone = args[4];
    const lines: Array<string> = [];
    for (let page = 1; page <= 100; page++) {
      const listed = runCf([
        'email-routing',
        'rules',
        'list-account',
        '--zone',
        zone,
        '--page',
        String(page),
        '--per-page',
        '100',
      ]);
      if (listed.status !== 0) {
        return listed;
      }
      const items = parsedJson(listed.stdout);
      if (!Array.isArray(items)) {
        throw new Error('Email Routing rules were malformed.');
      }
      for (const entry of items.map(object)) {
        const actions = Array.isArray(entry.actions)
          ? entry.actions.map((action) => {
              const item = object(action);
              return item.type === 'worker'
                ? `worker:${item.value}`
                : item.type === 'forward' && Array.isArray(item.value)
                  ? `forward:${item.value.join(',')}`
                  : String(item.type);
            })
          : [];
        const matchers = Array.isArray(entry.matchers) ? entry.matchers.map(object) : [];
        if (matchers.some((item) => item.type === 'all')) {
          lines.push(
            `Catch-all rule: ${entry.enabled === true ? 'enabled' : 'disabled'}, action: ${actions.join(', ')}`,
          );
        } else {
          if (typeof entry.id !== 'string') {
            throw new Error('Email Routing rule ID was missing.');
          }
          const recipients = matchers
            .filter((item) => item.type === 'literal' || item.type === 'to')
            .map((item) => `to:${item.value}`);
          lines.push(
            `Rule: ${entry.id}\n  Name: ${entry.name || '(none)'}\n  Enabled: ${entry.enabled === true}\n  Matchers: ${recipients.join(', ')}\n  Actions: ${actions.join(', ')}\n  Priority: ${entry.priority ?? 0}`,
          );
        }
      }
      if (items.length < 100) {
        return result(0, lines.length ? `${lines.join('\n')}\n` : 'No routing rules found.\n');
      }
    }
    throw new Error('Email Routing rules exceeded the supported page limit.');
  }
  if (product === 'sending' && operation === 'settings') {
    const listed = runCf(['email-sending', 'subdomains', 'list', '--zone', emailZone(candidate)]);
    if (listed.status !== 0) {
      return listed;
    }
    const values = parsedJson(listed.stdout);
    if (!Array.isArray(values)) {
      throw new Error('Email Sending subdomains were malformed.');
    }
    const match = values.map(object).find((item) => item.name === candidate);
    if (!match) {
      return result(1, '', `No sending subdomain found for \`${candidate}\`.`);
    }
    const tag = match.tag ?? match.id;
    if (typeof tag !== 'string') {
      throw new Error('Email Sending subdomain ID was missing.');
    }
    return result(
      0,
      `Email Sending for ${candidate}:\n  Enabled: ${match.enabled === true}\n  Tag: ${tag}\n`,
    );
  }
  if (product === 'sending' && operation === 'enable') {
    return runCf([
      'email-sending',
      'subdomains',
      'create',
      '--zone',
      emailZone(candidate),
      '--name',
      candidate,
    ]);
  }
  return result(1, '', `Unsupported Cloudflare email operation: ${product} ${operation}.`);
}

async function secrets(): Promise<Result> {
  const worker = workerName();
  const verb = args[1];
  const apply = async (action: () => Result): Promise<Result> => {
    const first = action();
    if (first.status === 0 || !/\[code:\s*10007\]/.test(first.stderr)) {
      return first;
    }
    // A first secret may be set before the application has ever deployed. cf's
    // secret endpoint needs an existing Worker, so create a targetless draft.
    const raw = {
      name: worker,
      account_id: process.env.CLOUDFLARE_ACCOUNT_ID ?? config().account_id,
      compatibility_date: config().compatibility_date ?? '2025-01-01',
      workers_dev: false,
      preview_urls: false,
    };
    const draft = await withBuildOutput(raw, null, (directory) =>
      runCf(['deploy', '--prebuilt', '--message', 'void:secret-draft'], directory),
    );
    return draft.status === 0 ? action() : draft;
  };
  if (verb === 'list') {
    const listed = runCf(['workers', 'secrets', 'list', '--worker', worker]);
    if (listed.status !== 0 && /\[code:\s*(?:10007|10090)\]/.test(listed.stderr)) {
      return result(1, '', `Worker "${worker}" not found. [code: 10007]`);
    }
    return listed;
  }
  if (verb === 'put' && args[2]) {
    const value = readFileSync(0, 'utf8').replace(/\n$/, '');
    return await withSecretFile(
      JSON.stringify({ name: args[2], text: value, type: 'secret_text' }),
      (path) =>
        apply(() =>
          runCf([
            'workers',
            'secrets',
            'update',
            args[2],
            '--worker',
            worker,
            '--body',
            `@${path}`,
          ]),
        ),
    );
  }
  if (verb === 'bulk') {
    const input = object(parsedJson(readFileSync(0, 'utf8')));
    const patch = Object.fromEntries(
      Object.entries(input).map(([name, text]) => [
        name,
        {
          type: 'secret_text',
          text,
        },
      ]),
    );
    return await withSecretFile(JSON.stringify(patch), (path) =>
      apply(() => runCf(['workers', 'secrets', 'bulk', '--worker', worker, '--file', path])),
    );
  }
  if (verb === 'delete' && args[2]) {
    return runCf(['workers', 'secrets', 'delete', args[2], '--worker', worker, '--force']);
  }
  return result(1, '', `Unsupported Cloudflare secret operation: ${verb}.`);
}

async function workerHistory(): Promise<Result> {
  const worker = workerName();
  const [group, verb, third] = args;
  if (group === 'deployments' && (verb === 'status' || verb === 'list')) {
    const called = runCf(['workers', 'deployments', 'list', '--worker', worker]);
    if (called.status !== 0) {
      return called;
    }
    const deployments = object(parsedJson(called.stdout)).deployments;
    if (!Array.isArray(deployments)) {
      throw new Error('Worker deployments were malformed.');
    }
    if (verb === 'status') {
      return deployments[0]
        ? result(0, `${JSON.stringify(deployments[0])}\n`)
        : result(1, '', 'Worker has no active deployment.');
    }
    return result(0, `${JSON.stringify(deployments)}\n`);
  }
  if (group === 'versions' && verb === 'list') {
    return cleanJson(['workers', 'versions', 'list', '--worker-id', worker], (value) => {
      if (!Array.isArray(value)) {
        throw new Error('Worker versions were malformed.');
      }
      return value.map((entry) => {
        const version = object(entry);
        return { ...version, metadata: { created_on: version.created_on } };
      });
    });
  }
  if (group === 'versions' && verb === 'view' && third) {
    const called = runCf(['workers', 'versions', 'get', third, '--worker-id', worker]);
    if (called.status !== 0) {
      return called;
    }
    const version = object(parsedJson(called.stdout));
    if (version.id !== third || !Array.isArray(version.bindings)) {
      throw new Error('Worker version bindings were malformed.');
    }
    const resources = await readVersionResources(worker, third);
    return result(0, `${JSON.stringify({ ...version, resources })}\n`);
  }
  if (group === 'versions' && verb === 'deploy') {
    const firstFlag = args.findIndex((part, index) => index >= 2 && part.startsWith('-'));
    const parts = args.slice(2, firstFlag === -1 ? undefined : firstFlag);
    const versions = parts.map((part) => {
      const [version_id, fraction] = part.split('@');
      const percentage = Number(fraction);
      if (!/^[0-9a-f-]{36}$/i.test(version_id ?? '') || !Number.isFinite(percentage)) {
        throw new Error('Cloudflare deployment version was malformed.');
      }
      return { version_id, percentage };
    });
    if (
      !versions.length ||
      Math.abs(versions.reduce((sum, entry) => sum + entry.percentage, 0) - 100) > 0.001
    ) {
      throw new Error('Cloudflare deployment percentages must total 100.');
    }
    const message = field('--message');
    return runCf([
      'workers',
      'deployments',
      'create',
      '--worker',
      worker,
      '--body',
      JSON.stringify({
        strategy: 'percentage',
        versions,
        ...(message ? { annotations: { 'workers/message': message } } : {}),
      }),
    ]);
  }
  return result(1, '', `Unsupported Cloudflare Worker history operation: ${group} ${verb}.`);
}

async function workerChanges(): Promise<Result> {
  if (args[0] === 'queues' && args[1] === 'consumer' && args[2] === 'remove') {
    const queueName = args[3];
    const worker = args[4];
    if (!queueName || !worker) {
      throw new Error('Queue consumer target is missing.');
    }
    const queue = (await readAllQueues()).find((item) => item.queue_name === queueName);
    if (!queue || typeof queue.queue_id !== 'string') {
      return result(1, '', `Queue "${queueName}" does not exist`);
    }
    const consumers = runCf(['queues', 'consumers', 'list', '--queue-id', queue.queue_id]);
    if (consumers.status !== 0) {
      return consumers;
    }
    const members = parsedJson(consumers.stdout);
    if (!Array.isArray(members)) {
      throw new Error('Queue consumer list was malformed.');
    }
    for (const item of members.map(object).filter((entry) => entry.script === worker)) {
      if (typeof item.consumer_id !== 'string') {
        throw new Error('Queue consumer ID is missing.');
      }
      const deleted = runCf([
        'queues',
        'consumers',
        'delete',
        item.consumer_id,
        '--queue-id',
        queue.queue_id,
        '--force',
      ]);
      if (deleted.status !== 0) {
        return deleted;
      }
    }
    return result(0);
  }
  if (args[0] === 'triggers' && args[1] === 'deploy') {
    const raw = config();
    const name = workerName();
    if (raw.name !== name) {
      throw new Error('Cloudflare trigger Worker name changed.');
    }
    return await withBuildOutput(raw, null, (directory) =>
      runCf(
        [
          'workers',
          'triggers',
          'deploy',
          '--prebuilt',
          ...(args.includes('--dry-run') ? ['--dry-run'] : []),
        ],
        directory,
      ),
    );
  }
  if (args[0] === 'triggers' && args[1] === 'clear-crons') {
    const raw = config();
    const name = workerName();
    if (raw.name !== name || (raw.account_id !== undefined && raw.account_id !== accountId())) {
      throw new Error('Cloudflare trigger target changed.');
    }
    return await clearWorkerCronSchedules(name);
  }
  if (args[0] === 'triggers' && args[1] === 'clear-domains') {
    const raw = config();
    const name = workerName();
    if (raw.name !== name || (raw.account_id !== undefined && raw.account_id !== accountId())) {
      throw new Error('Cloudflare trigger target changed.');
    }
    return await clearWorkerCustomDomains(name);
  }
  if ((args[0] === 'versions' && args[1] === 'upload') || args[0] === 'deploy') {
    const raw = config();
    const path = configPath()!;
    if (typeof raw.main !== 'string' || !raw.main || raw.no_bundle !== true) {
      throw new Error('Cloudflare Worker upload requires a prebuilt platform Worker.');
    }
    const source = resolve(dirname(path), raw.main);
    const message = field('--message');
    const secrets = field('--secrets-file');
    return await withBuildOutput(raw, source, (directory) =>
      runCf(
        [
          ...(args[0] === 'deploy' ? ['deploy'] : ['workers', 'versions', 'create']),
          '--prebuilt',
          ...(message ? ['--message', message] : []),
          ...(secrets ? ['--secrets-file', secrets] : []),
          ...(args.includes('--dry-run') ? ['--dry-run'] : []),
        ],
        directory,
      ),
    );
  }
  return result(1, '', `Unsupported Cloudflare Worker operation: ${args.slice(0, 2).join(' ')}.`);
}

async function tail(): Promise<Result> {
  const worker = args[1];
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? config().account_id;
  if (!worker || typeof accountId !== 'string' || !accountId || worker !== workerName()) {
    throw new Error('Cloudflare tail target is not pinned.');
  }
  const filters: Array<Json> = [];
  if (field('--search')) {
    filters.push({ query: field('--search') });
  }
  if (field('--version-id')) {
    filters.push({ scriptVersion: field('--version-id') });
  }
  if (field('--status') === 'error') {
    filters.push({ outcome: ['exception', 'exceededCpu', 'exceededMemory', 'unknown'] });
  }
  const base = (
    process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4'
  ).replace(/\/$/, '');
  const endpoint = `${base}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}/tails`;
  const headers = { ...apiHeaders(), 'Content-Type': 'application/json' };
  const stopped = new AbortController();
  let socket: WebSocket | undefined;
  let finish: (() => void) | undefined;
  const stop = () => {
    stopped.abort();
    socket?.close();
    finish?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let record: Json | undefined;
  try {
    const created = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filters }),
      signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(30_000)]),
    });
    const body = object(await created.json());
    if (!created.ok || body.success !== true) {
      return result(1, '', 'Could not start the Cloudflare Worker tail.');
    }
    record = object(body.result);
    if (typeof record.id !== 'string' || typeof record.url !== 'string') {
      throw new Error('Cloudflare Worker tail response was incomplete.');
    }
    const tailUrl = record.url;
    if (stopped.signal.aborted) {
      return result(0);
    }
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      socket = new WebSocket(tailUrl, 'trace-v1');
      socket.addEventListener('open', () => {
        socket!.send(JSON.stringify({ debug: false }));
      });
      socket.addEventListener('message', (event) => {
        try {
          const log = object(parsedJson(String(event.data)));
          const detail = object(log.event ?? {});
          const request = object(detail.request ?? {});
          const prefix =
            typeof request.url === 'string'
              ? `${request.method ?? 'GET'} ${request.url}`
              : typeof detail.queue === 'string'
                ? `Queue ${detail.queue}`
                : typeof detail.mailFrom === 'string'
                  ? `Email from ${detail.mailFrom}`
                  : 'Worker event';
          process.stdout.write(
            `${prefix} - ${log.outcome ?? 'unknown'} @ ${new Date(Number(log.eventTimestamp)).toLocaleString()}\n`,
          );
          if (Array.isArray(log.logs)) {
            for (const line of log.logs.map(object)) {
              process.stdout.write(
                `  (${line.level ?? 'log'}) ${Array.isArray(line.message) ? line.message.join(' ') : ''}\n`,
              );
            }
          }
          if (Array.isArray(log.exceptions)) {
            for (const exception of log.exceptions.map(object)) {
              process.stderr.write(`  ${exception.name ?? 'Error'}: ${exception.message ?? ''}\n`);
            }
          }
        } catch {
          process.stderr.write('Cloudflare returned a malformed tail event.\n');
        }
      });
      socket.addEventListener('error', () =>
        reject(new Error('Cloudflare Worker tail connection failed.')),
      );
      socket.addEventListener('close', () => resolve());
      if (stopped.signal.aborted) {
        resolve();
      }
    });
  } catch (error) {
    if (stopped.signal.aborted) {
      return result(0);
    }
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    socket?.close();
    if (record && typeof record.id === 'string') {
      await fetch(`${endpoint}/${encodeURIComponent(record.id)}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    // Node's WebSocket can remain in CLOSING after the remote tail is deleted.
    // This is a dedicated CLI process, so leave promptly after Ctrl+C.
    if (stopped.signal.aborted) {
      process.exit(0);
    }
  }
  return result(0);
}

async function main(): Promise<Result> {
  if (['whoami', 'login', 'logout', 'auth'].includes(args[0] ?? '')) {
    return auth();
  }
  if (args[0] === 'secret') {
    return await secrets();
  }
  if (args[0] === 'tail') {
    return await tail();
  }
  if (args[0] === 'email') {
    return email();
  }
  if (args[0] === 'deployments' || (args[0] === 'versions' && args[1] !== 'upload')) {
    return await workerHistory();
  }
  if (
    args[0] === 'triggers' ||
    args[0] === 'deploy' ||
    (args[0] === 'versions' && args[1] === 'upload') ||
    (args[0] === 'queues' && args[1] === 'consumer')
  ) {
    return await workerChanges();
  }
  if (['d1', 'kv', 'r2', 'hyperdrive', 'queues', 'containers'].includes(args[0] ?? '')) {
    return await resources();
  }
  return result(1, '', `Unsupported Cloudflare operation: ${args.slice(0, 2).join(' ')}.`);
}

try {
  const output = await main();
  if (output.stdout) {
    process.stdout.write(output.stdout);
  }
  if (output.stderr) {
    process.stderr.write(output.stderr);
  }
  process.exitCode = output.status;
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'Cloudflare command failed.');
  process.exitCode = 1;
}
