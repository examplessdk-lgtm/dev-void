import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  encodeCloudflareOperation,
  decodeCloudflareOperationResult,
} from '../../src/cli/cloudflare-process.ts';

// Gated live-account e2e for the `void deploy --platform cloudflare` path. Runs only when
// VOID_E2E_CF_TOKEN and VOID_E2E_CF_ACCOUNT_ID are set, and skips each test otherwise. See
// README.md in this directory for prerequisites, CI wiring, and resource naming/cleanup.

// Read env inside hooks and tests, never at module load: Vitest collects this file before the
// runner injects the job env, so a top-level read sees empty credentials.
function cfToken(): string {
  return process.env.VOID_E2E_CF_TOKEN ?? '';
}
function cfAccountId(): string {
  return process.env.VOID_E2E_CF_ACCOUNT_ID ?? '';
}
// Live cf calls are unverified on Windows; cloudflare-deploy-build.test.ts covers the build there.
function e2eEnabled(): boolean {
  return cfToken().length > 0 && cfAccountId().length > 0 && process.platform !== 'win32';
}
const NO_CREDS_NOTE =
  'VOID_E2E_CF_TOKEN + VOID_E2E_CF_ACCOUNT_ID not set (or win32) — live deploy skipped';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = join(ROOT, 'packages', 'void');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const CF_BIN = join(PACKAGE_ROOT, 'node_modules', 'cf', 'bin', 'cf');
const OPERATION_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cloudflare-operation-process.mjs');
// `spawn.sync` blocks the event loop, so Vitest cannot time out a hung call and teardown would
// never run. Bound every spawn below its hook timeout.
const DEPLOY_TIMEOUT_MS = 480_000;
const CF_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
// Total cf time per hook, since several blocking calls run back to back. Setup: 90s +
// DEPLOY_TIMEOUT_MS < 600s; teardown: 200s + the ~64s worker probe < 300s.
const SETUP_CF_BUDGET_MS = 90_000;
const TEARDOWN_CF_BUDGET_MS = 200_000;

// The SPA playground uses D1, KV and a cron.
const APP = join(ROOT, 'playground', 'spa');
const APP_WRANGLER = join(APP, 'wrangler.jsonc');

// A unique name per run keeps overlapping runs apart; the shared prefix keeps orphans greppable.
// D1/KV names mirror the provisioner's `suffixedResourceName`.
function uniqueRunSuffix(): string {
  // `||`, not `??`: vite.config.ts forwards an unset VOID_E2E_RUN_ID as ''.
  const raw =
    process.env.VOID_E2E_RUN_ID ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // Cloudflare names are lowercase [a-z0-9-], cannot start or end with '-', and max out at 63 chars.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 28)
    .replace(/^-+|-+$/g, '');
  return cleaned || 'local';
}
let WORKER_NAME = '';
let D1_NAME = '';
let KV_TITLE = '';
function computeResourceNames(): void {
  WORKER_NAME = `void-e2e-cf-deploy-${uniqueRunSuffix()}`;
  D1_NAME = `${WORKER_NAME}-db`;
  KV_TITLE = `${WORKER_NAME}-kv`;
}

const COMPAT_DATE = '2026-02-24';

let wranglerSnapshotTaken = false;
let wranglerOriginal: string | undefined;
let deployOutput = '';
let deployStatus: number | null = null;
// Teardown deletes only after the ownership gate proved the names were free before the deploy.
let ownershipVerified = false;

/** The credentialed env every real Cloudflare call (deploy + teardown) shares. */
function cloudEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: cfToken(),
    CLOUDFLARE_ACCOUNT_ID: cfAccountId(),
  };
  // The direct fetches use the public api.cloudflare.com, so cf must too. Otherwise teardown could
  // miss a worker deployed to another API base and leak it.
  delete env.CLOUDFLARE_API_BASE_URL;
  delete env.CF_API_BASE_URL;
  delete env.WRANGLER_API_ENVIRONMENT;
  delete env.CLOUDFLARE_COMPLIANCE_REGION;
  return env;
}

// Deadline for the current hook's total cf time (see SETUP_/TEARDOWN_CF_BUDGET_MS).
let cfDeadline = Number.POSITIVE_INFINITY;

/** Best-effort pinned cf invocation for setup and teardown. */
function cf(args: Array<string> | CloudflareOperation): {
  status: number;
  stdout: string;
  output: string;
} {
  // Once the hook budget is spent, fail the call instead of spawning; every caller fails closed.
  const remaining = cfDeadline - Date.now();
  if (remaining <= 0) {
    return {
      status: 1,
      stdout: '',
      output: `cf ${Array.isArray(args) ? args.join(' ') : args.type} skipped — hook Cloudflare time budget exhausted`,
    };
  }
  const res = spawn.sync(
    process.execPath,
    Array.isArray(args) ? [CF_BIN, ...args] : [OPERATION_ENTRY, ...encodeCloudflareOperation(args)],
    {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...cloudEnv(), CF_DELEGATION: '1' },
      timeout: Math.min(CF_TIMEOUT_MS, remaining),
    },
  );
  const decoded = Array.isArray(args)
    ? res
    : decodeCloudflareOperationResult({
        status: res.status,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        signal: res.signal,
        error: res.error?.message,
      });
  const stdout =
    'data' in decoded && decoded.data !== undefined
      ? JSON.stringify(decoded.data)
      : (decoded.stdout ?? '');
  const stderr = decoded.stderr ?? '';
  // Parse JSON from `stdout` only: cf can print notices to stderr on success.
  return {
    status: decoded.status ?? 1,
    stdout,
    output: `${stdout}${stderr}${res.error ? `\n${res.error}` : ''}`,
  };
}

/**
 * Ask the CF API whether the worker exists: `cf` exits nonzero for a missing worker too, so its
 * exit code cannot tell. Returns 'unknown' after three tries without a 200 or 404.
 */
async function workerExistence(): Promise<'exists' | 'absent' | 'unknown'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${WORKER_NAME}`,
        {
          headers: { Authorization: `Bearer ${cfToken()}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (res.status === 200) {
        return 'exists';
      }
      if (res.status === 404) {
        return 'absent';
      }
    } catch {
      // Retry network errors.
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return 'unknown';
}

/** Extract the deployed workers.dev URL the CLI prints on a successful deploy. */
function extractWorkerUrl(output: string): string | undefined {
  // The host has two labels before workers.dev: `<worker>.<account-subdomain>`.
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?/)?.[0];
}

/** A `setTimeout` delay that also resolves immediately when `signal` aborts, so a pending retry wait
 * never outlives a timed-out test. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Poll until a 200, retrying any other status: a new workers.dev host can 404 while its route
 * propagates. Returns the last response, or throws when no attempt got a response.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 40,
  delayMs = 3000,
  signal?: AbortSignal,
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    // Stop once the test times out, so retries do not leak into later tests.
    if (signal?.aborted) {
      break;
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal:
          init.signal ??
          (signal
            ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      });
      if (res.status === 200) {
        return res;
      }
      lastResponse = res;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
    }
    if (i < attempts - 1) {
      await abortableDelay(delayMs, signal);
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error(`worker at ${url} never answered`);
}

/** Report whether the worker's workers.dev route is enabled, to diagnose a persistent 404. */
async function workersDevEnabled(): Promise<string> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${WORKER_NAME}/subdomain`,
      {
        headers: { Authorization: `Bearer ${cfToken()}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => ({}))) as { result?: unknown };
    return `workers.dev subdomain endpoint ${res.status}: ${JSON.stringify(body.result ?? body)}`;
  } catch (error) {
    return `workers.dev subdomain check errored: ${String(error)}`;
  }
}

/** Authenticated GET against the Cloudflare API for THIS deployed worker (Bearer `cfToken()`). */
async function cfWorkerApi(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${WORKER_NAME}${path}`,
    {
      headers: { Authorization: `Bearer ${cfToken()}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
}

describe('void deploy --platform cloudflare (live account)', () => {
  beforeAll(async () => {
    if (!e2eEnabled()) {
      return;
    }
    cfDeadline = Date.now() + SETUP_CF_BUDGET_MS;
    computeResourceNames();

    // Ownership gate: provisioning adopts an existing D1/KV with the same name and teardown deletes
    // by name, so refuse to run on any collision. An ambiguous lookup counts as a collision.
    const collisions: Array<string> = [];

    const worker = await workerExistence();
    if (worker === 'exists') {
      collisions.push(`worker ${WORKER_NAME}`);
    } else if (worker === 'unknown') {
      collisions.push(`worker ${WORKER_NAME} (could not confirm it is free — lookup errored)`);
    }

    // `d1 info` cannot tell a missing database from an error, so list them all.
    const d1List = cf({ type: 'd1.list' });
    if (d1List.status !== 0) {
      collisions.push(`d1 database ${D1_NAME} (could not list databases to rule out a collision)`);
    } else {
      try {
        const databases = JSON.parse(d1List.stdout) as Array<{ name: string }>;
        if (databases.some((d) => d.name === D1_NAME)) {
          collisions.push(`d1 database ${D1_NAME}`);
        }
      } catch {
        collisions.push(
          `d1 database ${D1_NAME} (non-JSON database list — cannot rule out a collision)`,
        );
      }
    }

    const kvList = cf({ type: 'kv.namespace.list' });
    if (kvList.status !== 0) {
      collisions.push(
        `kv namespace ${KV_TITLE} (could not list namespaces to rule out a collision)`,
      );
    } else {
      try {
        const namespaces = JSON.parse(kvList.stdout) as Array<{ title: string }>;
        if (namespaces.some((n) => n.title === KV_TITLE)) {
          collisions.push(`kv namespace ${KV_TITLE}`);
        }
      } catch {
        collisions.push(
          `kv namespace ${KV_TITLE} (non-JSON namespace list — cannot rule out a collision)`,
        );
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        'live e2e refuses to run — these throwaway-named resources already exist in the target ' +
          'account, so provisioning would adopt/migrate them and teardown would delete them ' +
          `(risking data this test does not own):\n  ${collisions.join('\n  ')}\n` +
          'Remove them (or change WORKER_NAME) and rerun.',
      );
    }
    ownershipVerified = true;

    // Snapshot before writing so an early failure never deletes a local file.
    wranglerOriginal = existsSync(APP_WRANGLER) ? readFileSync(APP_WRANGLER, 'utf-8') : undefined;
    wranglerSnapshotTaken = true;

    // No D1/KV ids, so the deploy must provision them. `account_id` pins every step to the test
    // account. The deploy migrates this file into void.config.ts.
    const overlay = {
      name: WORKER_NAME,
      compatibility_date: COMPAT_DATE,
      account_id: cfAccountId(),
    };
    writeFileSync(APP_WRANGLER, `${JSON.stringify(overlay, null, 2)}\n`);

    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--platform', 'cloudflare'], {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
      timeout: DEPLOY_TIMEOUT_MS,
    });
    deployStatus = res.status;
    deployOutput = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error}` : ''}`;
  }, 600_000);

  afterAll(async () => {
    // Independent best-effort deletes, even after a failed deploy. A failed delete or a lookup that
    // cannot confirm a resource is gone is collected and thrown after the config restore.
    const failures: Array<string> = [];
    const attemptDelete = (label: string, args: Array<string>): void => {
      const res = cf(args);
      if (res.status !== 0) {
        failures.push(`${label} (exit ${res.status})\n${res.output.trim()}`);
      }
    };
    if (e2eEnabled() && ownershipVerified) {
      cfDeadline = Date.now() + TEARDOWN_CF_BUDGET_MS;
      // Skip only a worker the API confirms absent; 'unknown' still tries the delete.
      const worker = await workerExistence();
      if (worker !== 'absent') {
        attemptDelete(`worker ${WORKER_NAME}`, ['workers', 'delete', WORKER_NAME, '--force']);
      }
      const d1List = cf({ type: 'd1.list' });
      if (d1List.status !== 0) {
        failures.push(`d1 list (exit ${d1List.status})\n${d1List.output.trim()}`);
      } else {
        try {
          const databases = JSON.parse(d1List.stdout) as Array<{ name: string; uuid: string }>;
          const database = databases.find((d) => d.name === D1_NAME);
          if (database && typeof database.uuid === 'string' && database.uuid) {
            attemptDelete(`d1 ${D1_NAME}`, ['d1', 'delete', database.uuid, '--force']);
          } else if (database) {
            failures.push(`d1 ${D1_NAME} has no ID — delete the database manually`);
          }
        } catch {
          failures.push(
            `d1 list returned non-JSON output — delete the ${D1_NAME} database manually`,
          );
        }
      }
      // KV delete needs the namespace id; match the exact title.
      const list = cf({ type: 'kv.namespace.list' });
      if (list.status !== 0) {
        failures.push(`kv namespace list (exit ${list.status})\n${list.output.trim()}`);
      } else {
        try {
          const namespaces = JSON.parse(list.stdout) as Array<{ id: string; title: string }>;
          const ns = namespaces.find((n) => n.title === KV_TITLE);
          if (ns && typeof ns.id === 'string' && ns.id) {
            attemptDelete(`kv ${KV_TITLE}`, ['kv', 'namespaces', 'delete', ns.id, '--force']);
          } else if (ns) {
            failures.push(`kv ${KV_TITLE} has no ID — delete the namespace manually`);
          }
        } catch {
          failures.push(
            `kv namespace list returned non-JSON output — delete the ${KV_TITLE} namespace manually`,
          );
        }
      }
    }
    // Restore the root config before surfacing teardown failures.
    if (wranglerSnapshotTaken) {
      if (wranglerOriginal === undefined) {
        rmSync(APP_WRANGLER, { force: true });
      } else {
        writeFileSync(APP_WRANGLER, wranglerOriginal);
      }
    }
    if (failures.length > 0) {
      throw new Error(`live e2e teardown failed — manual cleanup needed:\n${failures.join('\n')}`);
    }
  }, 300_000);

  it('deploys the worker to the live account', (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    expect(deployStatus, deployOutput).toBe(0);
    const url = extractWorkerUrl(deployOutput);
    expect(url, deployOutput).toBeDefined();
    // A concurrent local run sharing the playground could have deployed another worker.
    const workerLabel = new URL(url!).hostname.split('.')[0];
    expect(workerLabel, `deployed host for ${url}`).toBe(WORKER_NAME);
  });

  it('serves a live 200 from the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const url = `${base!.replace(/\/$/, '')}/api/hello`;
    const res = await fetchWithRetry(url, {}, 40, 3000, ctx.signal);
    const diagnostic =
      res.status === 200 ? '' : ` — GET ${url} → ${res.status}; ${await workersDevEnabled()}`;
    expect(res.status, `worker ${WORKER_NAME}${diagnostic}`).toBe(200);
  }, 200_000);

  it('persists data through the live D1 binding', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const root = base!.replace(/\/$/, '');
    // A 500 means the remote D1 migration or binding failed. The live-200 test already waited for
    // the route, so shorter retries only cover cold start.
    const email = `e2e-${uniqueRunSuffix()}@example.com`;
    const created = await fetchWithRetry(
      `${root}/api/users`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'E2E User', email }),
      },
      15,
      2000,
      ctx.signal,
    );
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(200);
    expect(JSON.parse(createdBody)).toEqual({ created: true });

    const list = await fetchWithRetry(`${root}/api/users`, {}, 15, 2000, ctx.signal);
    const listBody = await list.text();
    expect(list.status, listBody).toBe(200);
    const rows = JSON.parse(listBody) as Array<{ email: string }>;
    expect(
      rows.some((u) => u.email === email),
      `posted user ${email} not found in ${listBody}`,
    ).toBe(true);
  }, 120_000);

  it('round-trips a value through the live KV binding', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const root = base!.replace(/\/$/, '');
    const key = `probe-${uniqueRunSuffix()}`;
    const value = `kv-${Date.now().toString(36)}`;
    const put = await fetchWithRetry(
      `${root}/api/kv/${key}`,
      { method: 'PUT', body: value },
      15,
      2000,
      ctx.signal,
    );
    expect(put.status, `PUT /api/kv/${key}`).toBe(200);
    // KV can cache a first-read miss for ~60s, so poll past that window.
    const got = await fetchWithRetry(`${root}/api/kv/${key}`, {}, 40, 2000, ctx.signal);
    const gotBody = await got.text();
    expect(got.status, gotBody).toBe(200);
    expect(gotBody).toBe(value);
  }, 150_000);

  it('registers the cron trigger on the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    // Check the registered schedule through the CF API instead of waiting for the hourly run.
    let crons: Array<string | undefined> = [];
    let diag = 'no response';
    for (let attempt = 0; attempt < 8; attempt++) {
      if (ctx.signal.aborted) {
        break;
      }
      try {
        const res = await cfWorkerApi('/schedules', ctx.signal);
        const body = (await res.json().catch(() => ({}))) as {
          result?: { schedules?: Array<{ cron?: string }> };
        };
        diag = `status ${res.status}: ${JSON.stringify(body)}`;
        if (res.status === 200) {
          crons = (body.result?.schedules ?? []).map((s) => s.cron);
          if (crons.includes('0 * * * *')) {
            break;
          }
        }
      } catch (error) {
        diag = `fetch threw: ${String(error)}`;
      }
      if (attempt < 7) {
        await abortableDelay(2000, ctx.signal);
      }
    }
    expect(crons, `registered schedules — ${diag}`).toContain('0 * * * *');
  }, 60_000);

  it('re-deploys idempotently to the same worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    // Runs last: redeploys with the config the first deploy wrote, reusing the worker, D1 and KV.
    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--platform', 'cloudflare'], {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
      timeout: DEPLOY_TIMEOUT_MS,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error}` : ''}`;
    expect(res.status, output).toBe(0);
    // Read the URL from this deploy's own output, not the first deploy's.
    const base = extractWorkerUrl(output);
    expect(base, output).toBeDefined();
    expect(new URL(base!).hostname.split('.')[0], output).toBe(WORKER_NAME);
    const root = base!.replace(/\/$/, '');
    // /api/users reads D1, so a dropped binding would return 500.
    const served = await fetchWithRetry(`${root}/api/hello`, {}, 15, 2000, ctx.signal);
    expect(served.status).toBe(200);
    const dbRoute = await fetchWithRetry(`${root}/api/users`, {}, 15, 2000, ctx.signal);
    expect(dbRoute.status, await dbRoute.text()).toBe(200);
  }, 600_000);
});
