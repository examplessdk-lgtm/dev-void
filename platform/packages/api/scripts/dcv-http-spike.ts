/**
 * Security spike: HTTP-DCV + ownership-gate wildcard-hijack reproduction.
 *
 * Drives the Cloudflare custom_hostnames API to empirically prove that the
 * planned switch from cert-DCV `txt` back to `http` (while KEEPING the
 * `_cf-custom-hostname` ownership TXT + an ownership-driven activation gate)
 * does NOT reopen the pre-PR #154 wildcard hijack.
 *
 * THE EXPLOIT BEING TESTED
 *   Pre-#154, Void created custom hostnames with `ssl.method: 'http'` and NO
 *   ownership gate. A victim whose zone published a wildcard
 *   `*.victim → cname.void.app` let ANY Void account bind `x.victim` because
 *   CF auto-validated the cert through the wildcard CNAME and the platform
 *   routed on cert-DCV alone. The fix keeps HTTP cert-DCV but refuses to route
 *   until the per-host `_cf-custom-hostname` TXT (which a wildcard cannot
 *   forge) is satisfied — i.e. until `ownership_verification` disappears.
 *
 * THE PLATFORM GATE THIS SCRIPT EVALUATES (matches the planned domains.ts gate)
 *   gateOk = status === 'active'
 *         && ssl.status === 'active'
 *         && !ownership_verification
 *
 * EXPERIMENTS
 *   A — hijack attempt: create `x.<VICTIM_BASE>` with ssl {method:'http',
 *       type:'dv'}, publish NO `_cf-custom-hostname` TXT, and poll. PASS iff
 *       the gate is NEVER true, `ownership_verification` persists, and `status`
 *       never reaches `active`. FAIL (abort the whole change) otherwise.
 *   B — residual probe: report whether `ssl.status` reaches `active` while
 *       `status` stays pending (unserved cert / CT-log noise). Expected and
 *       accepted per the plan; bounded by the Phase-3 janitor. Never fails.
 *   C — positive control: a DOCUMENTED manual variant. The operator publishes a
 *       specific `x2.<VICTIM_BASE> CNAME cname.void.app` PLUS its
 *       `_cf-custom-hostname` TXT, then runs with `--with-positive-control`.
 *       Confirms `status`→active, `ssl.status`→active,
 *       `ownership_verification` disappears, gate flips true. Proves we don't
 *       strand legitimate users. Skipped (reported `skipped`) by default.
 *
 * PREREQUISITES
 *   - A SEPARATE Cloudflare account hosting a throwaway VICTIM zone with a
 *     wildcard `*.<VICTIM_BASE>  CNAME  cname.void.app` record. This is the
 *     attacker's lever; without it Experiment A is meaningless. Test both
 *     orange- and grey-cloud variants of that wildcard for full coverage.
 *   - CF_ZONE_ID / CF_API_TOKEN below belong to the VOID for-SaaS zone (the
 *     attacker's account) — the zone that issues `POST /custom_hostnames`.
 *     They are NOT the victim account's credentials.
 *   - For Experiment C only: before running, in the VICTIM zone publish
 *       x2.<VICTIM_BASE>            CNAME  cname.void.app
 *       _cf-custom-hostname.x2...   TXT    <value printed by this script on a
 *                                          prior dry create, or read from CF>
 *
 * ENV VARS (config from env/CLI only — NEVER hardcode secrets)
 *   CF_ZONE_ID    (required)  Void for-SaaS zone id that owns custom_hostnames.
 *   CF_API_TOKEN  (required)  Token with custom_hostnames edit on that zone.
 *   VICTIM_BASE   (required)  Victim base hostname, e.g. `victim-spike.example`.
 *                             Experiment A registers `x.<VICTIM_BASE>`,
 *                             Experiment C uses `x2.<VICTIM_BASE>`.
 *
 * CLI FLAGS (all optional)
 *   --window=<sec>            Total poll window per experiment. Default 180s.
 *                             A REAL run needs >=86400s (>=24h) to clear CF's
 *                             DCV backoff — the default is a smoke run only and
 *                             a short window cannot upgrade a FAIL to a PASS.
 *   --interval=<sec>          Initial poll interval (capped backoff). Default 10s.
 *   --max-interval=<sec>      Backoff ceiling. Default 60s.
 *   --with-positive-control   Also run Experiment C (requires the manual DNS
 *                             setup above). Off by default.
 *   --hostname-a=<host>       Override Experiment A hostname (default x.<base>).
 *   --hostname-c=<host>       Override Experiment C hostname (default x2.<base>).
 *
 * HOW TO RUN (oxnode — do NOT use tsx/node-strip)
 *   CF_ZONE_ID=... CF_API_TOKEN=... VICTIM_BASE=victim-spike.example \
 *     oxnode packages/api/scripts/dcv-http-spike.ts
 *
 *   Real (>=24h) run with positive control:
 *   CF_ZONE_ID=... CF_API_TOKEN=... VICTIM_BASE=victim-spike.example \
 *     oxnode packages/api/scripts/dcv-http-spike.ts \
 *       --window=90000 --with-positive-control
 *
 * !!! WARNING !!!
 *   This hits the LIVE Cloudflare API and creates real custom hostnames + cert
 *   orders. Target STAGING / DISPOSABLE domains ONLY. Every hostname this
 *   script creates is DELETEd on exit (including on error / SIGINT), but a
 *   crash before cleanup can orphan a hostname + leave a CT-log entry — manually
 *   `DELETE /zones/{zone}/custom_hostnames/{id}` if that happens.
 */

import {
  type CustomHostnameInfo,
  cfFetch,
  deleteCustomHostname,
  getCustomHostname,
} from '../src/provisioning/cloudflare-api.ts';

const CF_ZONE_API_BASE = 'https://api.cloudflare.com/client/v4/zones';

// ── Config ──────────────────────────────────────────────────────────

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error('See the top-of-file comment for the full prerequisites.');
    process.exit(1);
  }
  return value;
}

function readNumberFlag(name: string, fallback: number): number {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!flag) {
    return fallback;
  }
  const value = Number(flag.slice(flag.indexOf('=') + 1));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid --${name} value; expected a positive number.`);
    process.exit(1);
  }
  return value;
}

const zoneId = readEnv('CF_ZONE_ID');
const apiToken = readEnv('CF_API_TOKEN');
const victimBase = readEnv('VICTIM_BASE');

const windowSec = readNumberFlag('window', 180);
const intervalSec = readNumberFlag('interval', 10);
const maxIntervalSec = readNumberFlag('max-interval', 60);
const withPositiveControl = process.argv.includes('--with-positive-control');

function readHostFlag(name: string, fallback: string): string {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(flag.indexOf('=') + 1) : fallback;
}

const hostnameA = readHostFlag('hostname-a', `x.${victimBase}`);
const hostnameC = readHostFlag('hostname-c', `x2.${victimBase}`);

// ── CF client ───────────────────────────────────────────────────────

// Mirrors the platform's `createCustomHostname` (cloudflare-api.ts) but pins
// `ssl.method: 'http'` — that's the pre-#154 cert-DCV mode this spike must
// reproduce. The platform's own helper hardcodes `'txt'`, so the body is
// inlined here rather than imported. `custom_metadata` is intentionally
// omitted (Enterprise-only add-on; see the helper's comment).
async function createHttpDcvHostname(hostname: string): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(`${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames`, apiToken, {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: { method: 'http', type: 'dv' },
    }),
  });
}

// ── Gate (matches the planned domains.ts activation gate) ────────────

function evaluateGate(cfHostname: CustomHostnameInfo): boolean {
  return (
    cfHostname.status === 'active' &&
    cfHostname.ssl.status === 'active' &&
    !cfHostname.ownership_verification &&
    !cfHostname.ownership_verification_http
  );
}

// ── Poll loop ───────────────────────────────────────────────────────

type PollSample = Readonly<{
  at: string;
  elapsedSec: number;
  status: string;
  ssl_status: string;
  has_ownership_verification: boolean;
  gate_ok: boolean;
  verification_errors?: ReadonlyArray<string>;
}>;

type PollResult = Readonly<{
  samples: ReadonlyArray<PollSample>;
  gateEverTrue: boolean;
  statusEverActive: boolean;
  sslEverActive: boolean;
  ownershipPersisted: boolean;
  last: CustomHostnameInfo;
}>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function snapshot(cfHostname: CustomHostnameInfo, elapsedSec: number): PollSample {
  return {
    at: new Date().toISOString(),
    elapsedSec,
    status: cfHostname.status,
    ssl_status: cfHostname.ssl.status,
    has_ownership_verification: Boolean(cfHostname.ownership_verification),
    gate_ok: evaluateGate(cfHostname),
    verification_errors: cfHostname.verification_errors,
  };
}

/**
 * Poll a custom hostname on a capped exponential backoff for up to `windowSec`.
 * For the hijack experiment (`stopOnGate: false`) we poll the full window to
 * confirm the gate stays false the entire time. For the positive control
 * (`stopOnGate: true`) we exit early once the gate flips true.
 */
async function pollHostname(
  hostnameId: string,
  label: string,
  stopOnGate: boolean,
): Promise<PollResult> {
  const start = Date.now();
  const samples: Array<PollSample> = [];
  let interval = intervalSec * 1000;
  let last: CustomHostnameInfo;
  let gateEverTrue = false;
  let statusEverActive = false;
  let sslEverActive = false;
  let ownershipMissedOnce = false;

  while (true) {
    last = await getCustomHostname(zoneId, apiToken, hostnameId);
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    const sample = snapshot(last, elapsedSec);
    samples.push(sample);
    console.log(
      `  [${label}] t+${elapsedSec}s status=${sample.status} ssl=${sample.ssl_status} ` +
        `ownership=${sample.has_ownership_verification ? 'present' : 'GONE'} ` +
        `gate=${sample.gate_ok ? 'TRUE' : 'false'}`,
    );

    gateEverTrue = gateEverTrue || sample.gate_ok;
    statusEverActive = statusEverActive || last.status === 'active';
    sslEverActive = sslEverActive || last.ssl.status === 'active';
    if (!sample.has_ownership_verification) {
      ownershipMissedOnce = true;
    }

    if (stopOnGate && sample.gate_ok) {
      break;
    }

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= windowSec * 1000) {
      break;
    }
    const remainingMs = windowSec * 1000 - elapsedMs;
    await sleep(Math.min(interval, remainingMs));
    interval = Math.min(interval * 2, maxIntervalSec * 1000);
  }

  return {
    samples,
    gateEverTrue,
    statusEverActive,
    sslEverActive,
    ownershipPersisted: !ownershipMissedOnce,
    last,
  };
}

// ── Cleanup tracking ────────────────────────────────────────────────

const createdHostnameIds = new Set<string>();

let cleaningUp = false;

async function cleanup(): Promise<void> {
  // Guard against re-entrancy (finally + a signal handler both calling in).
  if (cleaningUp) {
    return;
  }
  cleaningUp = true;
  for (const id of createdHostnameIds) {
    try {
      await deleteCustomHostname(zoneId, apiToken, id);
      console.log(`  cleaned up custom hostname ${id}`);
    } catch (err) {
      console.error(
        `  WARNING: failed to delete custom hostname ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      console.error(`  Manually: DELETE ${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${id}`);
    }
  }
  createdHostnameIds.clear();
}

// ── Experiments ─────────────────────────────────────────────────────

type ExperimentResult = Readonly<{
  pass: boolean | null; // null = not applicable (B never fails; C when skipped)
  status: 'pass' | 'fail' | 'residual-accepted' | 'skipped';
  details: Record<string, unknown>;
}>;

// Experiment A — hijack attempt. PASS iff the gate is never true,
// ownership_verification persists, and status never reaches active.
async function experimentA(): Promise<ExperimentResult> {
  console.log(`\nExperiment A — hijack attempt: ${hostnameA} (NO ownership TXT published)`);
  const created = await createHttpDcvHostname(hostnameA);
  createdHostnameIds.add(created.id);
  console.log(
    `  created id=${created.id} ssl.method=${created.ssl.method ?? 'n/a'} ` +
      `ownership=${created.ownership_verification ? 'present' : 'absent'}`,
  );

  const poll = await pollHostname(created.id, 'A', false);
  const pass = !poll.gateEverTrue && poll.ownershipPersisted && !poll.statusEverActive;

  return {
    pass,
    status: pass ? 'pass' : 'fail',
    details: {
      hostname: hostnameA,
      cf_hostname_id: created.id,
      gate_ever_true: poll.gateEverTrue,
      status_ever_active: poll.statusEverActive,
      ownership_verification_persisted: poll.ownershipPersisted,
      window_sec: windowSec,
      note:
        windowSec < 86_400
          ? 'SMOKE run only — a definitive PASS requires --window>=86400 to clear CF DCV backoff.'
          : 'Full DCV backoff window covered.',
      samples: poll.samples,
    },
  };
}

// Experiment B — residual probe over Experiment A's same pending hostname.
// Reports whether ssl.status reached active while status stayed pending
// (unserved cert / CT-log noise). Expected + accepted; never fails.
function experimentB(a: PollResult): ExperimentResult {
  const sslActiveWhileStatusPending = a.samples.some(
    (sample) => sample.ssl_status === 'active' && sample.status !== 'active',
  );
  console.log(
    `\nExperiment B — residual probe: ssl.status reached active while status pending = ${sslActiveWhileStatusPending}`,
  );
  return {
    pass: null,
    status: 'residual-accepted',
    details: {
      ssl_active_while_status_pending: sslActiveWhileStatusPending,
      ssl_ever_active: a.sslEverActive,
      note: 'Accepted per plan; bounded by the Phase-3 cleanup janitor.',
    },
  };
}

// Experiment C — positive control (manual DNS setup required; opt-in).
// Confirms a legitimately-owned hostname activates and the gate flips true.
async function experimentC(): Promise<ExperimentResult> {
  if (!withPositiveControl) {
    console.log(
      '\nExperiment C — positive control: SKIPPED (pass --with-positive-control + publish DNS).',
    );
    return {
      pass: null,
      status: 'skipped',
      details: {
        note:
          'Skipped. To run: publish the specific CNAME + _cf-custom-hostname TXT for ' +
          `${hostnameC}, then re-run with --with-positive-control.`,
      },
    };
  }

  console.log(`\nExperiment C — positive control: ${hostnameC} (CNAME + ownership TXT published)`);
  const created = await createHttpDcvHostname(hostnameC);
  createdHostnameIds.add(created.id);
  console.log(
    `  created id=${created.id} ` +
      (created.ownership_verification
        ? `expected TXT ${created.ownership_verification.name} = ${created.ownership_verification.value}`
        : 'no ownership_verification returned'),
  );

  const poll = await pollHostname(created.id, 'C', true);
  const pass =
    poll.gateEverTrue &&
    poll.last.status === 'active' &&
    poll.last.ssl.status === 'active' &&
    !poll.last.ownership_verification;

  return {
    pass,
    status: pass ? 'pass' : 'fail',
    details: {
      hostname: hostnameC,
      cf_hostname_id: created.id,
      gate_ever_true: poll.gateEverTrue,
      final_status: poll.last.status,
      final_ssl_status: poll.last.ssl.status,
      ownership_verification_gone: !poll.last.ownership_verification,
      samples: poll.samples,
    },
  };
}

// ── Main ────────────────────────────────────────────────────────────

// A definitive Experiment-A PASS only counts if the poll window was long
// enough to clear CF's DCV backoff schedule. A short smoke run that happens
// not to see the gate flip is INCONCLUSIVE, not a pass — never let it gate a
// ship.
const MIN_CONCLUSIVE_WINDOW_SEC = 86_400;

async function main(): Promise<{ overall_pass: boolean }> {
  console.log('HTTP-DCV security spike — LIVE Cloudflare API. Staging/disposable domains only.');
  console.log(
    `  zone=${zoneId.slice(0, 6)}… victimBase=${victimBase} window=${windowSec}s ` +
      `interval=${intervalSec}s maxInterval=${maxIntervalSec}s positiveControl=${withPositiveControl}`,
  );

  const a = await experimentA();
  // Re-derive the poll result B needs from A's recorded samples.
  const b = experimentB({
    samples: a.details.samples as ReadonlyArray<PollSample>,
    gateEverTrue: a.details.gate_ever_true as boolean,
    statusEverActive: a.details.status_ever_active as boolean,
    sslEverActive: (a.details.samples as ReadonlyArray<PollSample>).some(
      (sample) => sample.ssl_status === 'active',
    ),
    ownershipPersisted: a.details.ownership_verification_persisted as boolean,
    last: {} as CustomHostnameInfo,
  });
  const c = await experimentC();

  const conclusiveWindow = windowSec >= MIN_CONCLUSIVE_WINDOW_SEC;
  const overall_pass =
    a.pass === true && (c.pass === true || c.status === 'skipped') && conclusiveWindow;

  const summary = {
    experiment_a_hijack: { status: a.status, pass: a.pass, details: a.details },
    experiment_b_residual: { status: b.status, details: b.details },
    experiment_c_positive_control: { status: c.status, pass: c.pass, details: c.details },
    conclusive_window: conclusiveWindow,
    overall_pass,
  };

  console.log('\n===== SPIKE SUMMARY (JSON) =====');
  console.log(JSON.stringify(summary, null, 2));
  if (a.pass === true && !conclusiveWindow) {
    console.log(
      `\n⚠️  Experiment A did not fail, but window=${windowSec}s < ${MIN_CONCLUSIVE_WINDOW_SEC}s ` +
        '— this is a SMOKE result, NOT a ship-gate pass. Re-run with --window=86400.',
    );
  }

  return { overall_pass };
}

// Clean up created hostnames even if the operator Ctrl-C's mid-poll.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal} — cleaning up before exit…`);
    void cleanup().then(() => process.exit(130));
  });
}

let exitCode = 0;
try {
  const { overall_pass } = await main();
  // Fail the process when the spike did not conclusively pass, so any CI or
  // scripted ship gate that keys on exit status cannot green-light on a
  // failing/inconclusive hijack experiment.
  exitCode = overall_pass ? 0 : 1;
} catch (err) {
  console.error(`\nSpike aborted with error: ${err instanceof Error ? err.stack : String(err)}`);
  exitCode = 1;
} finally {
  console.log('\nCleaning up created custom hostnames…');
  await cleanup();
}
process.exit(exitCode);
