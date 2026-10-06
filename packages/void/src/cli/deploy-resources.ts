import { readFileSync } from 'node:fs';
import {
  parseRootWranglerConfig,
  readStoredResourceName,
  readWranglerTopLevelString,
} from '@void/deploy-cloudflare';
import { basename, join } from 'pathslash';
import { type ApplicationAnalysis } from '../application-analysis.ts';
import { analyzeApplication, completeApplicationAnalysis } from '../application-routing.ts';
import { MATERIALIZED_CLOUDFLARE_FILE } from '../cloudflare-config.ts';
import { type DatabaseDialect, type VoidConfig } from '../config.ts';
import { collectRevalidate, hasRevalidate } from '../isr-config.ts';
import { hasEmailHandlers, type EmailHandlersScan } from '../router/email.ts';
import { DEFAULT_VOID_AI_BINDING } from './deploy-binding-snapshot.ts';
import { loadProvisionModule } from './deploy-provision.ts';
import {
  type CloudflareAuthSecretFailureReason,
  type DeployWranglerRunResult,
} from './deploy-types.ts';
// Type-only: the provision module must load lazily (see `deploy-types.ts`).
import type { DesiredResourceSet, ProvisionDriftEntry } from './provision.ts';

/** Human labels for a drifted resource kind, used in guidance messages. */
export const CLOUDFLARE_RESOURCE_LABELS: Record<ProvisionDriftEntry['kind'], string> = {
  d1: 'D1 database',
  kv: 'KV namespace',
  r2: 'R2 bucket',
  hyperdrive: 'Hyperdrive config',
};

export const BETTER_AUTH_SECRET_NAME = 'BETTER_AUTH_SECRET';

/** Values-free failure from the Cloudflare Better Auth secret lifecycle. */
export class CloudflareAuthSecretError extends Error {
  override name = 'CloudflareAuthSecretError';
  readonly reason: CloudflareAuthSecretFailureReason;

  constructor(message: string, reason: CloudflareAuthSecretFailureReason) {
    super(message);
    this.reason = reason;
  }
}

/** True only for a wrangler child that ran to completion with a clean exit 0. */
export function isCleanWranglerExit(result: DeployWranglerRunResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

const CLOUDFLARE_WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';

const CLOUDFLARE_CONTAINERS_PRICING_URL = 'https://developers.cloudflare.com/containers/pricing/';

/**
 * Actionable, output-independent guidance for the Sandbox entitlement probe.
 *
 * A nonzero `wrangler containers list` is intentionally not classified more narrowly: the
 * Containers API uses the same failure surface when the account has no Workers Paid entitlement
 * and when an API token lacks Containers / Cloudchamber permission. Claiming either one as fact
 * would send some users down the wrong path, so the message gives both deterministic remedies.
 */
export function formatCloudflareSandboxUnavailable(options?: { preflight?: boolean }): string {
  return [
    options?.preflight
      ? 'deploy: this app uses `void/sandbox`, but Void could not verify Cloudflare Containers with the current account and credentials.'
      : "deploy: Cloudflare rejected access to Containers while deploying this app's Sandbox.",
    'Cloudflare Containers require the Workers Paid plan and are not available on Workers Free.',
    '',
    `Enable Workers Paid: ${CLOUDFLARE_WORKERS_PAID_URL}`,
    `Containers pricing: ${CLOUDFLARE_CONTAINERS_PRICING_URL}`,
    '',
    'If this account already has Workers Paid:',
    '  • Run `void cloudflare login` again; or',
    '  • Give CLOUDFLARE_API_TOKEN Account / Containers: Edit and Account / Cloudchamber: Edit.',
    '',
    'Rerun the deploy; Void will verify Containers access automatically.',
    options?.preflight
      ? 'No resources were provisioned and the app was not built or deployed.'
      : 'The Sandbox container was not deployed.',
  ].join('\n');
}

/** The length cap {@link toValidWorkerName} applies (the CF plugin's own rule). */
const MAX_WORKER_NAME_LENGTH = 63;

/**
 * Sanitize a raw name into a valid Cloudflare Worker name — the SAME rule
 * `@cloudflare/vite-plugin`'s `toValidWorkerName` applies (lowercase, `_`→`-`,
 * any non `[a-z0-9-]`→`-`, strip leading/trailing dashes, ≤63 chars, empty →
 * `my-worker`). Deriving it identically means the name we pin in the config and
 * the name the build emits into `dist/ssr/wrangler.json` agree, so
 * `wrangler secret list -c <root>` and `wrangler deploy` target one worker.
 */
function toValidWorkerName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKER_NAME_LENGTH)
    .replace(/-+$/g, '');
  return name.length > 0 ? name : 'my-worker';
}

/**
 * Derive a `<worker>-<suffix>` resource name, RESERVING the suffix's budget before
 * the length cap applies.
 *
 * `toValidWorkerName` truncates whatever string it is handed, so
 * `toValidWorkerName(`${workerName}-kv`)` cuts from the RIGHT — the end that carries
 * the suffix. A worker name at or above the cap therefore loses the suffix entirely
 * and every derivation collapses to the bare (truncated) worker name, so `KV` and
 * `ISR_CACHE` would ask for ONE namespace title. Since KV titles are not
 * account-unique and the provisioner matches remote namespaces BY TITLE (re-listing
 * per binding), the second binding would adopt the namespace the first just created:
 * two bindings sharing one namespace and one quota slot.
 *
 * The suffix is kept intact by trimming the BASE to `63 - suffix.length - 1` first.
 * When the suffix survives the plain derivation (every worker name short enough to
 * leave room — the normal case), the result is byte-identical to what it has always
 * been, so no existing app's resource name churns.
 */
function suffixedResourceName(workerName: string, suffix: string): string {
  const full = toValidWorkerName(`${workerName}-${suffix}`);
  if (full.endsWith(`-${suffix}`)) {
    return full;
  }
  const base = toValidWorkerName(workerName)
    .slice(0, MAX_WORKER_NAME_LENGTH - suffix.length - 1)
    .replace(/-+$/g, '');
  return toValidWorkerName(`${base}-${suffix}`);
}

/**
 * Derive the worker name the way the CF plugin's `getWorkerNameFromProject` does
 * MINUS the `WRANGLER_CI_OVERRIDE_NAME` precedence: package.json `name` → directory
 * basename → `my-worker`. The override is deliberately NOT consulted — this backend
 * scrubs it from every child env and fences it in the project dotenv (see
 * {@link deployChildEnv} / {@link assertNoConfigOverrideInProjectDotenv}), so the
 * build emits (and the deploy uploads) the non-override name; deriving from the
 * override here would pin a name the scrubbed build never produces.
 */
export function deriveWorkerName(root: string): string {
  let pkgName: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      pkgName = pkg.name;
    }
  } catch {
    // no package.json / unreadable — fall through to the directory basename.
  }
  return toValidWorkerName(pkgName ?? basename(root) ?? '');
}

/**
 * Fail closed when two KV bindings of this deploy would end up on ONE namespace.
 *
 * KV is the only resource kind where a name collision silently WORKS: titles are not
 * account-unique, the provisioner matches remote namespaces BY TITLE, and it re-lists
 * per binding — so a second binding desiring an already-created title adopts that
 * namespace and reports success. Both checks below are cheap and purely local:
 *
 *  1. DESIRED titles must be distinct — catches any future suffix collision at the
 *     source, before a single namespace is created.
 *  2. Already-RECORDED ids must be distinct — an app provisioned before the suffix
 *     budget was reserved can carry two bindings pointing at the same namespace id.
 *     Read-first is keyed by binding and both entries hold a real id, so the
 *     provisioner would skip both forever and never surface it.
 *
 * Scoped to KV (and to the bindings THIS deploy manages): D1/R2/Hyperdrive names live
 * in separate Cloudflare namespaces and are identity-checked against their stored
 * values elsewhere.
 */
function assertDistinctKvNamespaces(
  kvNamespaces: Array<{ binding: string; title: string }>,
  config: Record<string, unknown>,
  configPath: string,
  isRealKvId: (value: unknown) => value is string,
): void {
  const bindingByTitle = new Map<string, string>();
  for (const { binding, title } of kvNamespaces) {
    const owner = bindingByTitle.get(title);
    if (owner !== undefined) {
      throw new Error(
        `deploy: KV bindings ${JSON.stringify(owner)} and ${JSON.stringify(binding)} both resolve ` +
          `to the namespace title ${JSON.stringify(title)}. KV titles are not account-unique, so ` +
          `provisioning would put both bindings on ONE namespace. Give the worker a shorter ` +
          `"name" in "${configPath}" so each binding derives its own title, then retry.`,
      );
    }
    bindingByTitle.set(title, binding);
  }

  const managed = new Set(kvNamespaces.map((kv) => kv.binding));
  const entries = config.kv_namespaces;
  if (!Array.isArray(entries)) {
    return;
  }
  const bindingById = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { binding, id } = entry as { binding?: unknown; id?: unknown };
    if (typeof binding !== 'string' || !managed.has(binding) || !isRealKvId(id)) {
      continue;
    }
    const owner = bindingById.get(id);
    if (owner !== undefined && owner !== binding) {
      throw new Error(
        `deploy: KV bindings ${JSON.stringify(owner)} and ${JSON.stringify(binding)} in ` +
          `"${configPath}" both point at KV namespace id ${JSON.stringify(id)}. They resolved to a ` +
          `single namespace when they were provisioned, so the two bindings share one namespace ` +
          `and one quota slot. Give one of them a fresh namespace (create it, or drop its entry ` +
          `from "${configPath}" and rerun the deploy), then retry.`,
      );
    }
    bindingById.set(id, binding);
  }
}

/**
 * Compute the DESIRED id/name-bearing Cloudflare resources from SOURCE
 * (pre-build, fail-fast) — the single set shared by the provision and drift
 * paths. Consumes the same application analysis as the plugin and managed
 * packaging; provider identities and stored resource names are resolved here.
 *
 * Resource NAMES prefer the value already stored in the root wrangler config
 * (so a re-provision reuses the same database/bucket and the provisioner's
 * stored-name identity check passes); otherwise they default off the worker
 * name. Returns a per-binding REASON map used to explain drift.
 */
export async function computeDesiredCloudflareResources(
  root: string,
  voidConfig: VoidConfig,
  configPath: string,
  application?: ApplicationAnalysis,
): Promise<{
  desired: DesiredResourceSet;
  reasons: Map<string, string>;
  /** Whether Void-managed auth is enabled (drives the auth-migration gate). */
  authEnabled: boolean;
  /** Resolved database dialect (sqlite → D1, postgresql → Hyperdrive). */
  dialect: DatabaseDialect;
  /** Absolute migrations dir on disk (sourceDir-aware) — used by the migrate gates. */
  migrationsDir: string;
  /** Checked-in migrations (`db/migrations/*.sql`) collected pre-build. */
  migrations: Array<{ name: string; sql: string }>;
  /**
   * Whether the pre-build inference found Workers AI use in the source — the SAME `needsAI`
   * signal `shouldBindWorkersAi` (index.ts) gates the emitted AI binding on. Threaded into
   * {@link verifyGeneratedDeployConfig} to authorize that binding.
   */
  needsAI: boolean;
  /** Workers AI binding emitted by the build (default `AI`). */
  aiBindingName: string;
  /**
   * Whether Void's build emits the sandbox container application — the SAME signal `mergeBindings`
   * (index.ts) gates emission on: `isSandboxEnabled(config)` (a `sandbox` field in `void.config.ts`) OR
   * the import walk detecting a `void/sandbox` import (`inferProjectBindings(...).needsSandbox`).
   * Threaded into {@link verifyGeneratedDeployConfig} (via {@link reconstructExpectedContainers})
   * to pin the emitted `containers` array.
   */
  needsSandbox: boolean;
  /** Whether the source imports void/live and the build may emit its Durable Object. */
  needsLive: boolean;
  analysis: ApplicationAnalysis;
  /**
   * The exact cron trigger schedules Void's build emits into `dist/ssr/wrangler.json`
   * `triggers.crons`, reconstructed PRE-BUILD from the SAME `scanJobsSync(root, paths.cronsDir)`
   * scan index.ts derives them from (`scanJobsSync(...).flatMap((job) => job.crons)`). Threaded
   * into {@link verifyGeneratedDeployConfig} to pin the emitted schedules against a build that
   * injected, dropped, or retargeted a Cron Trigger.
   */
  expectedCrons: Array<string>;
  /**
   * Whether the app uses email at all — inbound `email/` handlers ({@link hasEmailHandlers}) OR
   * an outbound `void/email` import (the import walk's `needsEmail`, the SAME signal index.ts
   * gates the dev inbox on). Gates the Mode B email step (3b-ii, design doc 0078); the managed
   * platform path never reads it.
   */
  needsEmail: boolean;
  /**
   * The `email/` handler scan the email step derives `addresses` from — the SAME
   * `scanEmailHandlersSync(paths.sourceRoot)` index.ts compiles the worker's `email()` export
   * from, so the routed addresses can never disagree with the dispatcher.
   */
  emailHandlers: EmailHandlersScan;
}> {
  // The id predicates are resolved via the memoized dynamic import so this exported
  // helper works when called directly in unit tests (outside the fork) without a
  // static provision edge that would eagerly load the provision lifecycle.
  const { isRealD1Id, isRealKvId } = await loadProvisionModule();
  const analysis = application
    ? await completeApplicationAnalysis(application)
    : await analyzeApplication(root, { config: voidConfig, environment: 'prod' });
  const { paths, bindings, authEnabled, dialect, bindingNames, migrations, needsDatabase } =
    analysis;
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name') ?? deriveWorkerName(root);

  // Checked-in migrations count toward the database gate, matching the managed
  // manifest (`buildVoidManifest`: `needsD1 || needsAuth || hasMigrations`). Without
  // this a migration-only SQLite app would provision no D1 and silently skip remote
  // migrations. Collected ONCE pre-build from `db/migrations/` (sourceDir-aware) and
  // carried through so the migrate step can skip when there are none and run the
  // deploy gates on the exact same files.
  // Config-relative migrations dir wrangler will resolve from the config-file dir
  // (the root). sourceDir moves the files to `<sourceDir>/db/migrations`, so the
  // written `migrations_dir` must include it — a hardcoded `./db/migrations` would
  // point wrangler at the wrong (or missing) folder for a sourceDir project.
  const migrationsDirRelative = paths.sourceDir
    ? `./${paths.sourceDir}/db/migrations`
    : './db/migrations';

  const desired: DesiredResourceSet = { kvNamespaces: [], queues: [] };
  const reasons = new Map<string, string>();

  // Database — desired on source-use OR auth OR checked-in migrations (the SAME
  // predicate the managed manifest applies), with the dialect selecting D1 (sqlite)
  // vs Hyperdrive (PostgreSQL/MySQL). This keeps provision/drift equivalent to the build:
  // a migration-only SQLite app still provisions D1, and an unused pg config does
  // not needlessly require Hyperdrive.
  const databaseReason = analysis.reasons.database[0]!;
  if (needsDatabase && dialect === 'sqlite') {
    const binding = bindingNames?.d1 ?? 'DB';
    // An explicitly authored name is the intended remote identity even before Void
    // has pinned its ID. Only inferred local placeholders need a generated name.
    const storedName = readStoredResourceName(config, 'd1_databases', binding, 'database_name');
    const storedId = readStoredResourceName(config, 'd1_databases', binding, 'database_id');
    const authoredName = voidConfig.cloudflare?.d1_databases?.find(
      (entry) => entry.binding === binding,
    )?.database_name;
    const name =
      storedName != null && isRealD1Id(storedId)
        ? storedName
        : authoredName?.trim() ||
          (basename(configPath) !== MATERIALIZED_CLOUDFLARE_FILE && storedName !== 'default'
            ? storedName
            : undefined) ||
          suffixedResourceName(workerName, 'db');
    // Carry the sourceDir-aware config-relative migrations dir so the provisioner
    // writes the correct `migrations_dir` (it otherwise hardcodes `./db/migrations`).
    desired.d1 = { binding, name, migrationsDir: migrationsDirRelative };
    reasons.set(binding, databaseReason);
  }

  // KV
  if (bindings.needsKV) {
    const binding = bindingNames?.kv ?? 'KV';
    desired.kvNamespaces.push({ binding, title: suffixedResourceName(workerName, 'kv') });
    reasons.set(binding, analysis.reasons.kv[0]!);
  }

  // R2
  if (bindings.needsR2) {
    const binding = bindingNames?.r2 ?? 'STORAGE';
    const storedName = readStoredResourceName(config, 'r2_buckets', binding, 'bucket_name');
    // Only a generated binding in a typed project uses `default` as a local
    // placeholder. In an authored root config, or an explicit typed Cloudflare
    // binding, it is a valid bucket name and must keep its identity.
    const generatedDefault =
      storedName === 'default' &&
      basename(configPath) === MATERIALIZED_CLOUDFLARE_FILE &&
      !voidConfig.cloudflare?.r2_buckets?.some(
        (entry) => entry.binding === binding && entry.bucket_name === 'default',
      );
    const bucketName =
      storedName && !generatedDefault ? storedName : suffixedResourceName(workerName, 'storage');
    desired.r2 = { binding, bucketName };
    reasons.set(binding, analysis.reasons.r2[0]!);
  }

  // Queues (resource names — account-unique; the build binds them for native apps).
  desired.queues = analysis.queues.map((q) => q.name);

  // Hyperdrive (PostgreSQL/MySQL apps) — same database gate as D1, dialect-selected. The
  // connection string is only consumed on a fresh create; a re-provision reads-first
  // from the config id and never needs it.
  if (needsDatabase && dialect !== 'sqlite') {
    const binding = 'HYPERDRIVE';
    desired.hyperdrive = {
      binding,
      name: suffixedResourceName(workerName, 'hyperdrive'),
      connectionString: process.env.DATABASE_URL ?? '',
    };
    reasons.set(
      binding,
      `app uses ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} (needs a Hyperdrive config)`,
    );
  }

  // ISR_CACHE (a KV namespace) — self-host-only, not in the import walk. Desired
  // when the merged revalidate config (void.config.ts `routing.revalidate` + per-page
  // `export const revalidate`) turns ISR on — the SAME gate the build's `emitIsr`
  // uses (`plugin-routing.ts`).
  const pageScan = analysis.scan.pages;
  if (hasRevalidate(collectRevalidate(voidConfig, pageScan))) {
    const binding = 'ISR_CACHE';
    desired.kvNamespaces.push({ binding, title: suffixedResourceName(workerName, 'isr-cache') });
    reasons.set(binding, 'routes use `revalidate` (ISR) — needs an ISR_CACHE KV namespace');
  }

  // Every KV binding must own its namespace — both the titles this deploy would
  // provision and the ids an earlier provision already recorded.
  assertDistinctKvNamespaces(desired.kvNamespaces, config, configPath, isRealKvId);

  // Cron trigger schedules — the EXACT expression index.ts emits into `triggers.crons`
  // (`scanJobsSync(root, paths.cronsDir).flatMap((job) => job.crons)`), from the SAME scan and the
  // SAME `paths` the build's emission sees, so a legitimate build's emitted schedules multiset-equal
  // this reconstruction.
  const expectedCrons = [...new Set(analysis.jobs.flatMap((job) => job.crons))];

  // Email — the handler directory is scanned from the SAME sourceRoot index.ts compiles it from
  // (`scanEmailHandlersSync(paths.sourceRoot)`); outbound-only use shows up as the import walk's
  // `needsEmail` (a `void/email` import anywhere in the scan dirs).
  const emailHandlers = analysis.email;

  return {
    analysis,
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir: paths.migrationsDir,
    migrations,
    needsAI: bindings.needsAI,
    aiBindingName: bindingNames?.ai ?? DEFAULT_VOID_AI_BINDING,
    expectedCrons,
    needsEmail: bindings.needsEmail === true || hasEmailHandlers(emailHandlers),
    emailHandlers,
    // Mirror index.ts's emission signal EXACTLY: the sandbox container is emitted when
    // `void.config.ts` enables it OR the source imports `void/sandbox` (the import-walk signal). Using
    // `isSandboxEnabled` alone would miss an import-only sandbox app (e.g. kitchen-sink) and the
    // container pin would then FALSE-POSITIVE a legitimate build.
    needsSandbox: bindings.needsSandbox,
    needsLive: bindings.needsLive === true,
  };
}
