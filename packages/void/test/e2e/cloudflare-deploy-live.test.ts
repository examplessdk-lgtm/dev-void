import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

// ---------------------------------------------------------------------------------------------
// Gated live-account e2e for the self-host `void deploy --backend cloudflare` path.
//
// INERT in normal CI. The whole suite is skipped unless BOTH env vars are present:
//   - VOID_E2E_CF_TOKEN       a Cloudflare API token with permissions to create + delete Workers
//                             Scripts, D1, and KV in the target account.
//   - VOID_E2E_CF_ACCOUNT_ID  the Cloudflare account id to deploy into.
//
// When they are set, this deploys the `playground/spa` app (D1 + KV + cron) to the target account
// under a FIXED, throwaway worker name — so reruns are idempotent and every resource is cleanable
// by a stable name — then asserts the live worker answers HTTP 200 and tears everything down.
//
// Why it does NOT drive `--provision`: `void deploy --provision` fails closed in non-interactive
// shells by design (a spawned CLI has no TTY, and CI cannot commit back the ids a create would
// mint). A subprocess can never satisfy that gate, so the test plays the role the provisioner
// would: it creates the id-bearing D1 + KV directly (`wrangler d1/kv … create`), writes their real
// ids into the root config exactly as `--provision` would, then runs the CI-safe
// `void deploy --backend cloudflare` (no `--provision`) — exercising the real build → tamper-guard
// → remote-migrations → `wrangler deploy` pipeline end to end against a live account.
//
// The live path is a MANUAL operator step: this repo's CI has no token, so the suite only ever
// SKIPS here. Do not commit a token; export the two vars locally to exercise the real path:
//   VOID_E2E_CF_TOKEN=... VOID_E2E_CF_ACCOUNT_ID=... vp test run packages/void/test/e2e
// ---------------------------------------------------------------------------------------------

const CF_TOKEN = process.env.VOID_E2E_CF_TOKEN ?? '';
const CF_ACCOUNT_ID = process.env.VOID_E2E_CF_ACCOUNT_ID ?? '';
const E2E_ENABLED = CF_TOKEN.length > 0 && CF_ACCOUNT_ID.length > 0;

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = join(ROOT, 'packages', 'void');
const CLI_ENTRY = join(PACKAGE_ROOT, 'dist', 'cli', 'cli.mjs');
const WRANGLER_BIN = join(PACKAGE_ROOT, 'node_modules', '.bin', 'wrangler');

// Deploy target: the SPA playground (real, buildable Void app exercising D1 + KV + a cron). The
// deploy CLI runs its own build → provision → migrate → deploy pipeline against this dir.
const APP = join(ROOT, 'playground', 'spa');
const APP_WRANGLER = join(APP, 'wrangler.jsonc');

// A FIXED throwaway worker name (no Date.now()/random, so a crashed run leaves a deterministically
// named worker + resources the next run — or an operator — can delete). The resource names mirror
// what the provisioner derives (`suffixedResourceName`): `<name>-db` (D1) and `<name>-kv` (KV).
const WORKER_NAME = 'void-e2e-cf-deploy';
const D1_NAME = `${WORKER_NAME}-db`;
const KV_TITLE = `${WORKER_NAME}-kv`;

// Binding names the SPA app resolves for its D1 + KV (Void's defaults: `void/db` → DB, `env.KV` →
// KV). The pre-created resources must be written into the root config under THESE bindings so the
// deploy's desired-set / drift-check sees them as satisfied.
const D1_BINDING = 'DB';
const KV_BINDING = 'KV';
// Where Void keeps D1 migrations — the deploy's no-provision path REQUIRES `migrations_dir` on the
// D1 entry (else it hard-errors), and `wrangler d1 migrations apply --remote` reads it. Matches what
// the provisioner stamps.
const MIGRATIONS_DIR = './db/migrations';
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
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
  };
  // This suite only supports the PUBLIC Cloudflare API + a `*.workers.dev` URL: `workerExistence()`
  // fetches `api.cloudflare.com` directly and the 200 assertion hits `*.workers.dev`. Scrub every
  // wrangler transport-redirect override inherited from the operator's shell so the spawned wrangler
  // calls AND the direct fetch resolve the SAME api base. Otherwise a worker deployed to a
  // staging/FedRAMP/custom base would 404 on the public api, and teardown's existence check would
  // treat it as absent and skip the delete — leaking the worker on the alternate base.
  delete env.CLOUDFLARE_API_BASE_URL;
  delete env.CF_API_BASE_URL;
  delete env.WRANGLER_API_ENVIRONMENT;
  delete env.CLOUDFLARE_COMPLIANCE_REGION;
  return env;
}

/** Best-effort `wrangler` invocation for teardown — never throws, so afterAll always continues. */
function wrangler(args: Array<string>): { status: number; output: string } {
  const res = spawn.sync(WRANGLER_BIN, args, {
    cwd: APP,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: cloudEnv(),
  });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * Definitively resolve whether the fixed-name worker already exists, for the ownership gate. The CF
 * API returns an unambiguous 200 (exists) / 404 (absent) for a script, unlike a wrangler exit code
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
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}`,
        { headers: { Authorization: `Bearer ${CF_TOKEN}` } },
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

/**
 * Create the throwaway D1 database directly and return its real id — the id-bearing half of what
 * `--provision` would do, but runnable non-interactively. `d1 create` has no JSON flag, so the id is
 * resolved from `d1 list --json` by EXACT name. Throws on any failure so `beforeAll` surfaces a
 * clear cause (teardown still deletes whatever got created).
 */
function createD1Database(): string {
  const created = wrangler(['d1', 'create', D1_NAME]);
  if (created.status !== 0) {
    throw new Error(
      `live e2e setup: "wrangler d1 create ${D1_NAME}" failed:\n${created.output.trim()}`,
    );
  }
  const list = wrangler(['d1', 'list', '--json']);
  if (list.status !== 0) {
    throw new Error(`live e2e setup: "wrangler d1 list" failed:\n${list.output.trim()}`);
  }
  let databases: Array<{ uuid: string; name: string }>;
  try {
    databases = JSON.parse(list.output) as Array<{ uuid: string; name: string }>;
  } catch {
    throw new Error(`live e2e setup: "wrangler d1 list" returned non-JSON:\n${list.output.trim()}`);
  }
  const db = databases.find((d) => d.name === D1_NAME);
  if (!db?.uuid) {
    throw new Error(`live e2e setup: D1 ${D1_NAME} not found in the account after create`);
  }
  return db.uuid;
}

/**
 * Create the throwaway KV namespace directly and return its real id. `kv namespace create <title>`
 * makes a namespace whose title is EXACTLY the argument (no worker prefix); the id is resolved from
 * `kv namespace list` by EXACT title. Throws on any failure.
 */
function createKvNamespace(): string {
  const created = wrangler(['kv', 'namespace', 'create', KV_TITLE]);
  if (created.status !== 0) {
    throw new Error(
      `live e2e setup: "wrangler kv namespace create ${KV_TITLE}" failed:\n${created.output.trim()}`,
    );
  }
  const list = wrangler(['kv', 'namespace', 'list']);
  if (list.status !== 0) {
    throw new Error(`live e2e setup: "wrangler kv namespace list" failed:\n${list.output.trim()}`);
  }
  let namespaces: Array<{ id: string; title: string }>;
  try {
    namespaces = JSON.parse(list.output) as Array<{ id: string; title: string }>;
  } catch {
    throw new Error(
      `live e2e setup: "wrangler kv namespace list" returned non-JSON:\n${list.output.trim()}`,
    );
  }
  const ns = namespaces.find((n) => n.title === KV_TITLE);
  if (!ns?.id) {
    throw new Error(`live e2e setup: KV ${KV_TITLE} not found in the account after create`);
  }
  return ns.id;
}

/** Extract the deployed workers.dev URL the CLI prints on a successful deploy. */
function extractWorkerUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s]*\.workers\.dev[^\s]*/)?.[0];
}

/**
 * Poll the live worker until it serves a 200 (edge propagation can lag the deploy by a few seconds,
 * and a freshly-deployed route can transiently 404 or 5xx before it is live). Retries on ANY
 * non-200 — not just 5xx — so a propagation-window 404 is not mistaken for the final answer. On
 * exhaustion returns the LAST response so the caller's status assertion reports the real final
 * status; throws only when every attempt was a network error (no response at all).
 */
async function fetchWithRetry(url: string, attempts = 10): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        return res;
      }
      lastResponse = res;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error(`worker at ${url} never answered`);
}

describe.skipIf(!E2E_ENABLED)('void deploy --backend cloudflare (live account)', () => {
  beforeAll(async () => {
    // Ownership gate — refuse to run if any fixed-name resource ALREADY exists in the target account.
    // `--provision` ADOPTS an exact-name D1/KV (it would migrate pre-existing data), and teardown
    // deletes by these exact names, so a collision with a real resource risks destroying data this
    // test does not own. Only after proving the names are exclusively ours do we set
    // `ownershipVerified` — the sole condition under which teardown deletes anything.
    //
    // Every check fails CLOSED: a lookup that neither confirms "free" nor confirms "taken" (a
    // transient API error, a missing read scope, a non-JSON body) is recorded as a collision, so an
    // ambiguous result can never be mistaken for a free name and let teardown delete a resource this
    // test did not create.
    const collisions: Array<string> = [];

    // Worker — a genuinely-absent worker ALSO makes `wrangler` exit nonzero, so an exit code cannot
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
    const d1List = wrangler(['d1', 'list', '--json']);
    if (d1List.status !== 0) {
      collisions.push(`d1 database ${D1_NAME} (could not list databases to rule out a collision)`);
    } else {
      try {
        const databases = JSON.parse(d1List.output) as Array<{ name: string }>;
        if (databases.some((d) => d.name === D1_NAME)) {
          collisions.push(`d1 database ${D1_NAME}`);
        }
      } catch {
        collisions.push(
          `d1 database ${D1_NAME} (non-JSON database list — cannot rule out a collision)`,
        );
      }
    }

    const kvList = wrangler(['kv', 'namespace', 'list']);
    if (kvList.status !== 0) {
      collisions.push(
        `kv namespace ${KV_TITLE} (could not list namespaces to rule out a collision)`,
      );
    } else {
      try {
        const namespaces = JSON.parse(kvList.output) as Array<{ title: string }>;
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

    // Play the provisioner's role: create the id-bearing D1 + KV directly (non-interactive), then
    // write their REAL ids into the root config exactly as `--provision` would — including the D1
    // `migrations_dir` the no-provision deploy requires. `account_id` is pinned so the deploy's
    // whoami / migrate / deploy all target the intended account.
    const databaseId = createD1Database();
    const kvId = createKvNamespace();
    const overlay = {
      name: WORKER_NAME,
      compatibility_date: COMPAT_DATE,
      account_id: CF_ACCOUNT_ID,
      d1_databases: [
        {
          binding: D1_BINDING,
          database_name: D1_NAME,
          database_id: databaseId,
          migrations_dir: MIGRATIONS_DIR,
        },
      ],
      kv_namespaces: [{ binding: KV_BINDING, id: kvId }],
    };
    writeFileSync(APP_WRANGLER, `${JSON.stringify(overlay, null, 2)}\n`);

    // The CI-safe path: no `--provision`. The root config now covers every desired id-bearing
    // resource, so the drift-check passes; this exercises build → tamper-guard → remote migrations →
    // `wrangler deploy` against the live account.
    const res = spawn.sync('node', [CLI_ENTRY, 'deploy', '--backend', 'cloudflare'], {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
    });
    deployStatus = res.status;
    deployOutput = `${res.stdout ?? ''}${res.stderr ?? ''}`;
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
      const res = wrangler(args);
      if (res.status !== 0) {
        failures.push(`${label} (exit ${res.status})\n${res.output.trim()}`);
      }
    };
    // Delete ONLY when the ownership gate proved these names were free before the deploy, so a
    // collision that aborted beforeAll never deletes a pre-existing resource the test does not own.
    if (E2E_ENABLED && ownershipVerified) {
      // Worker — exists only if the deploy succeeded. Skip when the CF API confirms it is ABSENT
      // (avoids a spurious "does not exist" failure on a deploy that never got that far); fail closed
      // when existence cannot be confirmed ('unknown') by attempting the delete anyway.
      const worker = await workerExistence();
      if (worker !== 'absent') {
        attemptDelete(`worker ${WORKER_NAME}`, ['delete', '--name', WORKER_NAME, '--force']);
      }
      // D1 — created in beforeAll; delete when the account still lists it by EXACT name. A list
      // failure cannot confirm the database is gone, so it is recorded (fail closed).
      const d1List = wrangler(['d1', 'list', '--json']);
      if (d1List.status !== 0) {
        failures.push(`d1 list (exit ${d1List.status})\n${d1List.output.trim()}`);
      } else {
        try {
          const databases = JSON.parse(d1List.output) as Array<{ name: string }>;
          if (databases.some((d) => d.name === D1_NAME)) {
            attemptDelete(`d1 ${D1_NAME}`, ['d1', 'delete', D1_NAME, '--skip-confirmation']);
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
      const list = wrangler(['kv', 'namespace', 'list']);
      if (list.status !== 0) {
        failures.push(`kv namespace list (exit ${list.status})\n${list.output.trim()}`);
      } else {
        try {
          const namespaces = JSON.parse(list.output) as Array<{ id: string; title: string }>;
          const ns = namespaces.find((n) => n.title === KV_TITLE);
          if (ns) {
            attemptDelete(`kv ${KV_TITLE}`, ['kv', 'namespace', 'delete', '--namespace-id', ns.id]);
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

  it('deploys the worker to the live account', () => {
    expect(deployStatus, deployOutput).toBe(0);
    // A successful `wrangler deploy` prints the worker's workers.dev URL.
    expect(deployOutput).toMatch(/https:\/\/[^\s]*\.workers\.dev/);
  });

  it('serves a live 200 from the deployed worker', async () => {
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const res = await fetchWithRetry(`${base!.replace(/\/$/, '')}/api/hello`);
    expect(res.status).toBe(200);
  });
});
