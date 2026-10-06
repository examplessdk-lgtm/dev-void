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

// Read the credentials + the enable gate at EXECUTION time, never at module top-level. Vitest imports
// (collects) this file BEFORE the CI runner injects the job's step env into the worker's process.env,
// so a top-level `process.env.VOID_E2E_CF_TOKEN` read sees an empty string and `describe.skipIf` would
// skip the suite even when the credentials are present — while an identical read inside a hook/test
// (which run AFTER injection) sees the real value. So these are functions, called from the hooks/tests.
function cfToken(): string {
  return process.env.VOID_E2E_CF_TOKEN ?? '';
}
function cfAccountId(): string {
  return process.env.VOID_E2E_CF_ACCOUNT_ID ?? '';
}
// Windows is intentionally excluded from the LIVE deploy: invoking the cf CLI against a real
// account on win32 is unverified. The real-build integration test
// (test/integration/cloudflare-deploy-build.test.ts) exercises the build path on Windows.
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
// Bound each deploy subprocess BELOW the enclosing vitest timeout. `spawn.sync` blocks the test
// worker's event loop, so a hung CLI/cf call would keep vitest's own timer from firing AND keep
// `afterAll` from running — leaking the worker/D1/KV. On timeout, spawnSync returns a null status,
// which fails the status assertion loudly and lets teardown reclaim the resources.
const DEPLOY_TIMEOUT_MS = 480_000;
// The same event-loop-block reasoning applies to every `cf` call (ownership lists and teardown):
// an unbounded `spawn.sync` on a stalled Cloudflare call would freeze vitest's hook timer and strand
// already-created resources. Quick ops, so a much shorter bound.
const CF_TIMEOUT_MS = 120_000;
// Per-request abort deadline for the polling fetches, so a single stalled request aborts and the
// retry loop moves on instead of consuming the whole per-test budget on one hung socket.
const REQUEST_TIMEOUT_MS = 20_000;
// `CF_TIMEOUT_MS` bounds ONE stalled call, but each hook fires SEVERAL cf calls back to
// back with no `await` between them (setup: 2 lists; teardown: up to 5 list/delete), so
// `spawn.sync` blocks the event loop across the whole run and vitest's hook timer can never fire to
// interrupt it — the per-call bound alone lets the AGGREGATE (5–6 × 120s) blow past the hook budget,
// and an external cancel mid-teardown strands D1/KV. These budgets cap the SUM of cf wall-clock
// per hook: each hook stamps `cfDeadline` at its start and `cf()` shrinks each call's
// timeout to the time left, skipping (as a failed call) once spent. Sized under the hook timeouts —
// setup: 90s + DEPLOY_TIMEOUT_MS (a separate spawn) = 570s < 600s beforeAll; teardown: 200s + the
// ~64s async worker probe = 264s < 300s afterAll.
const SETUP_CF_BUDGET_MS = 90_000;
const TEARDOWN_CF_BUDGET_MS = 200_000;

// Deploy target: the SPA playground (real, buildable Void app exercising D1 + KV + a cron). The
// deploy CLI runs its own build → provision → migrate → deploy pipeline against this dir.
const APP = join(ROOT, 'playground', 'spa');
const APP_WRANGLER = join(APP, 'wrangler.jsonc');

// A UNIQUE per-run worker name: two runs that overlap (two pushes in flight, a rerun of the same
// commit) must never deploy the same-named worker or create the same D1/KV, or they would clobber
// each other and teardown would race one against the other. The suffix is `VOID_E2E_RUN_ID` (CI
// sets it to run-id + attempt) or, locally, a timestamp + random. The shared
// `void-e2e-cf-deploy-` prefix keeps every resource greppable for manual cleanup of an orphan from a
// hard-killed run. Derived names mirror the provisioner (`suffixedResourceName`): `<name>-db` (D1),
// `<name>-kv` (KV).
function uniqueRunSuffix(): string {
  // `||`, not `??`: `VOID_E2E_RUN_ID` arrives as an EMPTY STRING (not undefined) when unset, because
  // `vite.config.ts` forwards `VOID_E2E_RUN_ID: process.env.VOID_E2E_RUN_ID ?? ''` into the worker
  // via `test.env`. `??` would treat that `''` as present and collapse every local run onto the
  // `-local` suffix (below), so overlapping local runs would clobber one shared worker/D1/KV. `||`
  // lets the empty value fall through to a unique timestamp + random. CI sets a non-empty run id, so
  // its value is unaffected.
  const raw =
    process.env.VOID_E2E_RUN_ID ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // Cloudflare worker/D1/KV names are lowercase `[a-z0-9-]` and must not start/end with `-`.
  // Sanitize, then cap the suffix so the worker name — and its `-db`/`-kv` tails — stay well under
  // the 63-char limit.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 28)
    .replace(/^-+|-+$/g, '');
  return cleaned || 'local';
}
// Computed in `beforeAll` (execution time), not here, so `VOID_E2E_RUN_ID` is read after the runner
// injects it — the same collection-vs-execution timing as the credentials above. A module-load read
// would always miss the CI run id and fall back to the timestamp.
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
// Set true ONLY once the pre-deploy ownership gate proves none of the fixed-name resources already
// existed in the account. Teardown deletes ONLY when this is true, so a collision (gate throws) can
// never delete a pre-existing resource the test does not own.
let ownershipVerified = false;

/** The credentialed env every real Cloudflare call (deploy + teardown) shares. */
function cloudEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: cfToken(),
    CLOUDFLARE_ACCOUNT_ID: cfAccountId(),
  };
  // This suite only supports the PUBLIC Cloudflare API + a `*.workers.dev` URL: `workerExistence()`
  // fetches `api.cloudflare.com` directly and the 200 assertion hits `*.workers.dev`. Scrub every
  // Cloudflare transport-redirect override inherited from the operator's shell so the spawned cf
  // calls AND the direct fetch resolve the SAME api base. Otherwise a worker deployed to a
  // staging/FedRAMP/custom base would 404 on the public api, and teardown's existence check would
  // treat it as absent and skip the delete — leaking the worker on the alternate base.
  delete env.CLOUDFLARE_API_BASE_URL;
  delete env.CF_API_BASE_URL;
  delete env.WRANGLER_API_ENVIRONMENT;
  delete env.CLOUDFLARE_COMPLIANCE_REGION;
  return env;
}

// Absolute wall-clock deadline (epoch ms) for the CURRENT hook's aggregate cf work; each hook
// stamps it at its start (see SETUP_/TEARDOWN_CF_BUDGET_MS). Infinity outside a hook so a stray
// call is still bounded by CF_TIMEOUT_MS alone.
let cfDeadline = Number.POSITIVE_INFINITY;

/** Best-effort pinned cf invocation for setup and teardown. */
function cf(args: Array<string> | CloudflareOperation): {
  status: number;
  stdout: string;
  output: string;
} {
  // Shrink this call's timeout to the time left in the hook's aggregate budget, so a run of stalled
  // calls can't collectively overrun the hook (spawn.sync blocks the loop, so vitest can't interrupt).
  // Once the budget is spent, skip the call as a failed one rather than launching a doomed spawn — the
  // ownership gate fails closed and teardown records the leak loudly instead of silently hanging.
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
      // Bound each call so a stalled CF request can't block the event loop and freeze teardown
      // (see CF_TIMEOUT_MS). On timeout, status is null → `?? 1` makes it a non-zero (failed) call,
      // which every caller already handles: the ownership gate fails closed, teardown records a failure.
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
  // `output` (stdout+stderr) is for human-facing error text only. JSON parsing must read `stdout`
  // ALONE: cf can print notices/warnings to stderr on a status-0 list, and any non-JSON
  // trailing the payload would make JSON.parse throw — breaking the ownership gate / teardown.
  return {
    status: decoded.status ?? 1,
    stdout,
    output: `${stdout}${stderr}${res.error ? `\n${res.error}` : ''}`,
  };
}

/**
 * Definitively resolve whether the fixed-name worker already exists, for the ownership gate. The CF
 * API returns an unambiguous 200 (exists) / 404 (absent) for a script, unlike a CLI exit code
 * (a genuinely-absent worker ALSO exits nonzero). A DEFINITIVE 200/404 is returned immediately; any
 * other outcome — a non-200/404 status or a network error — is retried a few times so a single
 * transient CF API blip (a 5xx, a 429, a dropped connection) does not needlessly fail the gate. Only
 * when EVERY attempt is non-definitive does it return `'unknown'`, which the gate treats as a
 * collision and fails closed on — so an ownership lookup that merely errored can never be mistaken
 * for "the name is free", while a lone hiccup no longer blocks an otherwise-clean run.
 */
async function workerExistence(): Promise<'exists' | 'absent' | 'unknown'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId()}/workers/scripts/${WORKER_NAME}`,
        {
          headers: { Authorization: `Bearer ${cfToken()}` },
          // Abort a stalled connection so the retry loop (and teardown that depends on it) stays
          // bounded — an accepted-but-never-answered request would otherwise hang the whole check.
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
      // Network error — transient; fall through to retry.
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return 'unknown';
}

/** Extract the deployed workers.dev URL the CLI prints on a successful deploy. */
function extractWorkerUrl(output: string): string | undefined {
  // `[a-z0-9.-]+` spans the MULTI-label host (`<worker>.<account-subdomain>.workers.dev`); the
  // optional `(?:\/[^\s]*)?` consumes only a real URL path, so a trailing sentence period (were the
  // URL ever printed in prose) is not captured. A bare `[a-z0-9-]+` before `.workers.dev` would NOT
  // match the two-label host and would return undefined — do not "simplify" it to that.
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
 * Poll the live worker until it serves a 200. A BRAND-NEW `*.workers.dev` hostname (every run uses a
 * unique worker name) needs the route to propagate globally before the first request succeeds, and
 * that window is materially longer from a CI runner's network path than from a dev machine — a run
 * observed a solid 30s of 404s before the route went live. So poll generously (~2 min). Retries on ANY
 * non-200 — not just 5xx — so a propagation-window 404 is not mistaken for the final answer. On
 * exhaustion returns the LAST response so the caller's status assertion reports the real final status;
 * throws only when every attempt was a network error (no response at all). `init` is forwarded to
 * `fetch` for non-GET requests (e.g. a KV `PUT`) and defaults to a GET.
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
    // Overall deadline: callers pass the test's `ctx.signal`, which vitest aborts at the test timeout.
    // Without it, a worker that accepts connections but never answers could keep this loop running
    // (e.g. 40 × ~22s ≈ 15 min) long after vitest already failed the test, leaking requests and timers
    // into later tests and teardown. Stop as soon as the enclosing test is done.
    if (signal?.aborted) {
      break;
    }
    try {
      const res = await fetch(url, {
        ...init,
        // Per-request deadline (fail a single stalled socket fast) AND the overall test signal, so
        // neither one request nor the whole loop can outlive its budget.
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

/**
 * Whether the deployed worker has its `*.workers.dev` route enabled, for diagnosing a persistent 404.
 * A propagation-window 404 has the route enabled (just not live yet); a route that is DISABLED 404s
 * forever. Best-effort — returns a short human string, never throws.
 */
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
      // Bound the request so one stalled schedules read aborts and the caller's retry loop continues;
      // when the caller passes the test signal, also abort the moment Vitest times the test out.
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
}

describe('void deploy --platform cloudflare (live account)', () => {
  beforeAll(async () => {
    // Gate at execution time (see the credential note): when the token/account are absent the suite is
    // a no-op — the tests below skip too. Compute the unique resource names now, from the injected env.
    if (!e2eEnabled()) {
      return;
    }
    // Cap the SUM of this hook's cf wall-clock (the ownership-gate lists)
    // so it plus the separate deploy spawn stays under the 600s beforeAll budget. The deploy is NOT a
    // cf() call, so it keeps its own DEPLOY_TIMEOUT_MS.
    cfDeadline = Date.now() + SETUP_CF_BUDGET_MS;
    computeResourceNames();

    // Ownership gate — refuse to run if any of this run's resources ALREADY exist in the target account.
    // Automatic provisioning ADOPTS an exact-name D1/KV (it would migrate pre-existing data), and teardown
    // deletes by these exact names, so a collision with a real resource risks destroying data this
    // test does not own. Only after proving the names are exclusively ours do we set
    // `ownershipVerified` — the sole condition under which teardown deletes anything.
    //
    // Every check fails CLOSED: a lookup that neither confirms "free" nor confirms "taken" (a
    // transient API error, a missing read scope, a non-JSON body) is recorded as a collision, so an
    // ambiguous result can never be mistaken for a free name and let teardown delete a resource this
    // test did not create.
    const collisions: Array<string> = [];

    // Worker — a genuinely-absent worker ALSO makes `cf` exit nonzero, so an exit code cannot
    // tell "free" from "errored". Resolve it against the CF API instead, which returns an unambiguous
    // 200/404; anything else is `'unknown'` → treated as a collision (fail closed).
    const worker = await workerExistence();
    if (worker === 'exists') {
      collisions.push(`worker ${WORKER_NAME}`);
    } else if (worker === 'unknown') {
      collisions.push(`worker ${WORKER_NAME} (could not confirm it is free — lookup errored)`);
    }

    // D1 — `d1 info <name>` exits nonzero BOTH when the database is absent and when the call errors,
    // so it cannot fail closed. List every database instead: a successful JSON list that omits the
    // name proves it is free; a list failure or non-JSON body is ambiguous → collision.
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
    // Exclusive ownership proven: any resource with these names after this point was created by THIS
    // run, so teardown may safely delete them.
    ownershipVerified = true;

    // Snapshot BEFORE any filesystem work so an early failure never deletes a developer-local file.
    wranglerOriginal = existsSync(APP_WRANGLER) ? readFileSync(APP_WRANGLER, 'utf-8') : undefined;
    wranglerSnapshotTaken = true;

    // Start from an intentionally incomplete config. The deploy itself must create D1 + KV and
    // persist their real ids/migrations_dir before continuing. `account_id` pins whoami,
    // provisioning, migration, and deploy to the intended account.
    const overlay = {
      name: WORKER_NAME,
      compatibility_date: COMPAT_DATE,
      account_id: cfAccountId(),
    };
    writeFileSync(APP_WRANGLER, `${JSON.stringify(overlay, null, 2)}\n`);

    // No extra flag: this exercises automatic provision → build → tamper guard → remote migrations
    // → `cf deploy` against the live account.
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
    // Tear DOWN the worker + the D1/KV created in `beforeAll`, even if the deploy or an assertion
    // failed. Each delete is best-effort and independent so one failure never blocks the others.
    // A delete is only required to succeed for a resource that STILL EXISTS: a resource confirmed
    // ABSENT (e.g. the deploy failed before the worker was created) is already gone — no leak, no
    // failure. A nonzero delete of a resource that IS present — or a lookup that cannot confirm the
    // resource is gone — is COLLECTED and re-thrown after cleanup + config restore, so a genuine
    // leak (or an ambiguous teardown) fails LOUD instead of reporting green.
    const failures: Array<string> = [];
    const attemptDelete = (label: string, args: Array<string>): void => {
      const res = cf(args);
      if (res.status !== 0) {
        failures.push(`${label} (exit ${res.status})\n${res.output.trim()}`);
      }
    };
    // Delete ONLY when the ownership gate proved these names were free before the deploy, so a
    // collision that aborted beforeAll never deletes a pre-existing resource the test does not own.
    if (e2eEnabled() && ownershipVerified) {
      // Cap the SUM of teardown's cf wall-clock (the worker probe is async + separately bounded)
      // so the whole cleanup stays under the 300s afterAll budget even if every list/delete stalls.
      cfDeadline = Date.now() + TEARDOWN_CF_BUDGET_MS;
      // Worker — exists only if the deploy succeeded. Skip when the CF API confirms it is ABSENT
      // (avoids a spurious "does not exist" failure on a deploy that never got that far); fail closed
      // when existence cannot be confirmed ('unknown') by attempting the delete anyway.
      const worker = await workerExistence();
      if (worker !== 'absent') {
        attemptDelete(`worker ${WORKER_NAME}`, ['workers', 'delete', WORKER_NAME, '--force']);
      }
      // D1 — created in beforeAll; delete when the account still lists it by EXACT name. A list
      // failure cannot confirm the database is gone, so it is recorded (fail closed).
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
      // KV delete needs the namespace id — resolve it from the account's namespace list by EXACT
      // title. Matching by exact title (not `endsWith`) avoids selecting an unrelated namespace that
      // merely shares the suffix. A namespace absent from the list is already gone (skip).
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
    // Restore the app's original root config (or remove the overlay if it had none) BEFORE surfacing
    // any teardown failure, so the working tree is always left clean.
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
    // A successful `void deploy` prints the worker's workers.dev URL.
    const url = extractWorkerUrl(deployOutput);
    expect(url, deployOutput).toBeDefined();
    // The host's FIRST label must be THIS run's worker name. If a concurrent local run had clobbered
    // the shared `wrangler.jsonc` overlay, the deploy would have targeted a different worker — this
    // catches that cross-run contamination rather than silently validating someone else's worker.
    const workerLabel = new URL(url!).hostname.split('.')[0];
    expect(workerLabel, `deployed host for ${url}`).toBe(WORKER_NAME);
  });

  it('serves a live 200 from the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const url = `${base!.replace(/\/$/, '')}/api/hello`;
    const res = await fetchWithRetry(url, {}, 40, 3000, ctx.signal);
    // On a persistent non-200, report the URL + whether the workers.dev route is even enabled, to
    // tell a slow-propagation 404 (route enabled) from a route that never went live (disabled).
    const diagnostic =
      res.status === 200 ? '' : ` — GET ${url} → ${res.status}; ${await workersDevEnabled()}`;
    expect(res.status, `worker ${WORKER_NAME}${diagnostic}`).toBe(200);
  }, 200_000);

  it('persists data through the live D1 binding', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const root = base!.replace(/\/$/, '');
    // A 500 here means the remote D1 migration never applied (no `users` table) or the DB binding did
    // not resolve — the exact deploy failure the static /api/hello check cannot catch. A unique email
    // keeps the read-back assertion precise regardless of any pre-existing rows. This (and the KV/
    // idempotency cases) run AFTER `serves a live 200` has already blocked until the hostname routes
    // globally, so their shorter retry budgets only need to cover worker cold-start, not propagation.
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
    // Proves the `KV` binding resolves to the real namespace end to end: write via the deployed worker,
    // then read it back. (The deploy in beforeAll created the namespace and pinned its id.)
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
    // KV is eventually consistent and a first-read MISS can be negatively cached at the edge for up to
    // ~60s, so poll past that window (40 × 2s = 80s). A healthy binding whose first GET raced the
    // write's central visibility then converges rather than false-failing CI.
    const got = await fetchWithRetry(`${root}/api/kv/${key}`, {}, 40, 2000, ctx.signal);
    const gotBody = await got.text();
    expect(got.status, gotBody).toBe(200);
    expect(gotBody).toBe(value);
  }, 150_000);

  it('registers the cron trigger on the deployed worker', async (ctx) => {
    ctx.skip(!e2eEnabled(), NO_CREDS_NOTE);
    // The deploy emits `triggers.crons` and Cloudflare registers them on the worker. We
    // assert the schedule is REGISTERED via the CF API — fast + deterministic — instead of waiting for
    // the hourly job to actually fire. Retry so a single transient CF-API blip (a 429/5xx or a network
    // throw) or a brief registration-visibility lag on the shared CI runner does not red an
    // otherwise-healthy deploy; a genuinely-unregistered cron still fails loud after the retries.
    let crons: Array<string | undefined> = [];
    let diag = 'no response';
    for (let attempt = 0; attempt < 8; attempt++) {
      // Stop as soon as Vitest times the test out: like `fetchWithRetry`, thread `ctx.signal` into the
      // request AND the inter-attempt delay so 8 × 20s of polling can't outlive the 60s test budget.
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
    // A SECOND `void deploy` against the already-created worker/D1/KV must succeed cleanly: the
    // existing D1/KV are reused, the remote migration is already applied (a no-op), and the worker
    // is updated in place. The overlay wrangler.jsonc is still on disk
    // (afterAll restores it only after every test), so this reuses it. Runs LAST for that reason.
    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--platform', 'cloudflare'], {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
      timeout: DEPLOY_TIMEOUT_MS,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error}` : ''}`;
    expect(res.status, output).toBe(0);
    // Prove THIS deploy re-targeted the same worker: read the URL from ITS OWN output (no fallback to
    // the first deploy, which would mask a second deploy that uploaded nothing) and require the host's
    // worker label to equal WORKER_NAME.
    const base = extractWorkerUrl(output);
    expect(base, output).toBeDefined();
    expect(new URL(base!).hostname.split('.')[0], output).toBe(WORKER_NAME);
    const root = base!.replace(/\/$/, '');
    // The re-deployed worker still serves AND its bindings survived the update: /api/hello (static) is
    // 200, and /api/users (a D1-backed route) is 200 — a dropped or broken DB binding would 500.
    const served = await fetchWithRetry(`${root}/api/hello`, {}, 15, 2000, ctx.signal);
    expect(served.status).toBe(200);
    const dbRoute = await fetchWithRetry(`${root}/api/users`, {}, 15, 2000, ctx.signal);
    expect(dbRoute.status, await dbRoute.text()).toBe(200);
  }, 600_000);
});
