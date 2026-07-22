import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

// ---------------------------------------------------------------------------------------------
// Gated live-account e2e for `void deploy --backend cloudflare --provision`.
//
// INERT in normal CI. The whole suite is skipped unless BOTH env vars are present:
//   - VOID_E2E_CF_TOKEN       a Cloudflare API token with permissions to create + delete Workers
//                             Scripts, D1, and KV in the target account.
//   - VOID_E2E_CF_ACCOUNT_ID  the Cloudflare account id to deploy into.
//
// When they are set, this runs a REAL provision + deploy of the `playground/spa` app (D1 + KV +
// cron) under a FIXED, throwaway worker name — so reruns are idempotent and every provisioned
// resource is cleanable by a stable name — asserts the live worker answers HTTP 200, then DELETES
// the worker + the provisioned D1 database + KV namespace in `afterAll` (which runs even on
// failure) and restores the overlaid root config.
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
const WRANGLER_BIN = join(ROOT, 'node_modules', '.bin', 'wrangler');

// Deploy target: the SPA playground (real, buildable Void app exercising D1 + KV + a cron). The
// deploy CLI runs its own build → provision → migrate → deploy pipeline against this dir.
const APP = join(ROOT, 'playground', 'spa');
const APP_WRANGLER = join(APP, 'wrangler.jsonc');

// A FIXED throwaway worker name (no Date.now()/random, so a crashed run leaves a deterministically
// named worker + resources the next run — or an operator — can delete). The provisioner derives the
// resource names from it (`suffixedResourceName`): `<name>-db` (D1) and `<name>-kv` (KV).
const WORKER_NAME = 'void-e2e-cf-deploy';
const D1_NAME = `${WORKER_NAME}-db`;
const KV_TITLE = `${WORKER_NAME}-kv`;

// The overlaid root config: only the throwaway worker name + a compat date. `--provision` writes the
// resolved `account_id` and the real binding ids into it during the deploy; teardown restores it.
const OVERLAY_WRANGLER = { name: WORKER_NAME, compatibility_date: '2026-02-24' };

let wranglerSnapshotTaken = false;
let wranglerOriginal: string | undefined;
let deployOutput = '';
let deployStatus: number | null = null;

/** The credentialed env every real Cloudflare call (deploy + teardown) shares. */
function cloudEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
  };
}

/** Best-effort `wrangler` invocation for teardown — never throws, so afterAll always continues. */
function wrangler(args: Array<string>): { status: number; output: string } {
  const res = spawnSync(WRANGLER_BIN, args, {
    cwd: APP,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: cloudEnv(),
  });
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Extract the deployed workers.dev URL the CLI prints on a successful deploy. */
function extractWorkerUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s]*\.workers\.dev[^\s]*/)?.[0];
}

/** Poll the live worker until it answers (edge propagation can lag the deploy by a few seconds). */
async function fetchWithRetry(url: string, attempts = 10): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) {
        return res;
      }
      lastError = new Error(`status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw lastError ?? new Error(`worker at ${url} never answered`);
}

describe.skipIf(!E2E_ENABLED)('void deploy --backend cloudflare --provision (live account)', () => {
  beforeAll(() => {
    // Snapshot BEFORE any filesystem work so an early failure never deletes a developer-local file.
    wranglerOriginal = existsSync(APP_WRANGLER) ? readFileSync(APP_WRANGLER, 'utf-8') : undefined;
    wranglerSnapshotTaken = true;
    writeFileSync(APP_WRANGLER, `${JSON.stringify(OVERLAY_WRANGLER, null, 2)}\n`);

    const res = spawnSync('node', [CLI_ENTRY, 'deploy', '--backend', 'cloudflare', '--provision'], {
      cwd: APP,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: cloudEnv(),
    });
    deployStatus = res.status;
    deployOutput = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  }, 600_000);

  afterAll(() => {
    // Tear DOWN every provisioned resource + the worker, even if the deploy or an assertion failed.
    // Each delete is best-effort and independent so one failure never blocks the others — but a
    // nonzero exit (transient API error / missing delete permission) is COLLECTED and re-thrown
    // after cleanup + config restore, so a run that leaves a worker or database behind fails LOUD
    // instead of reporting green with leaked resources.
    const failures: Array<string> = [];
    const attemptDelete = (label: string, args: Array<string>): void => {
      const res = wrangler(args);
      if (res.status !== 0) {
        failures.push(`${label} (exit ${res.status})\n${res.output.trim()}`);
      }
    };
    if (E2E_ENABLED) {
      attemptDelete(`worker ${WORKER_NAME}`, ['delete', '--name', WORKER_NAME, '--force']);
      attemptDelete(`d1 ${D1_NAME}`, ['d1', 'delete', D1_NAME, '--skip-confirmation']);
      // KV delete needs the namespace id — resolve it from the account's namespace list by EXACT
      // title. The provisioner creates AND matches the namespace by this exact title (the
      // provision-time existence check rejects any non-exact title), so an `endsWith` here could
      // select and delete an unrelated namespace that merely shares the suffix.
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

  it('provisions resources and deploys the worker', () => {
    expect(deployStatus, deployOutput).toBe(0);
    // The orchestrator names each provisioned resource + prints the deployed URL.
    expect(deployOutput).toMatch(/https:\/\/[^\s]*\.workers\.dev/);
  });

  it('serves a live 200 from the deployed worker', async () => {
    const base = extractWorkerUrl(deployOutput);
    expect(base, deployOutput).toBeDefined();
    const res = await fetchWithRetry(`${base!.replace(/\/$/, '')}/api/hello`);
    expect(res.status).toBe(200);
  });
});
