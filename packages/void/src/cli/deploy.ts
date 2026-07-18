import { execSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseJsoncConfig, type ParseError } from 'jsonc-parser';
import { basename, dirname, join, relative, resolve } from 'pathe';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const deployDriftCheckDir = join('.void', 'deploy-drift-check');
import { intro, outro, log, note, confirm, isCancel, type SpinnerResult } from '@clack/prompts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetConfig,
} from '../asset-routing.ts';
import { findVoidAuthConfig } from '../auth/config.ts';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { findEnvFile } from '../codegen/env-types.ts';
import {
  readConfig,
  resolveBindingNames,
  type DatabaseDialect,
  type RoutingConfig,
  type VoidConfig,
  getDatabaseDialect,
  isNodeTarget,
} from '../config.ts';
import { scanJobsSync } from '../crons/scan.ts';
import { writeDrizzleConfig } from '../drizzle/config.ts';
import { discoverSchema } from '../drizzle/discover.ts';
import { collectRevalidate, collectPages, hasRevalidate } from '../isr-config.ts';
import { voidWarn } from '../log.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { scanPages } from '../pages/scan.ts';
import type { PageScanResult } from '../pages/types.ts';
import {
  inferProjectBindings,
  FRAMEWORK_SCAN_DIRS,
  detectFramework,
  type DetectedFramework,
} from '../plugin-inference.ts';
import { collectPrerenderPaths, collectPrerenderPathsNode } from '../prerender.ts';
import {
  assertNoRootSourceConventionConflicts,
  readProjectPaths,
  resolveProjectPaths,
} from '../project-paths.ts';
import { scanQueuesSync } from '../queues/scan.ts';
import { scanRoutes } from '../router/scan.ts';
import { scanWebSocketRoutesSync } from '../router/websocket.ts';
import {
  isSandboxEnabled,
  requiresSandboxPlatformImage,
  resolveSandboxConfig,
} from '../sandbox/config.ts';
import { mergeAndExpand, parseDotenvFile, scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { resolveRemoteMode, stripInternalEnvKeys } from '../shared/env.ts';
import { validateSsrEntry } from '../ssr/entry.ts';
import { getApiUrl, getToken, getTokenSource } from './auth.ts';
import {
  isExpiredTokenError,
  PlatformClient,
  type DeploymentResponse,
  type ManifestOnlyDeployPayload,
} from './client.ts';
import { promptAndCreateProject } from './create-project.ts';
import {
  formatConnectionLostMessage,
  formatDeployFailureMessage,
  formatStreamDeployError,
} from './deploy-errors.ts';
import { uploadAssetsToR2, type DirectR2PutItem } from './direct-r2-upload.ts';
import type {
  EnvSchemaProbeInput,
  EnvSchemaProbeResult,
  EnvSchemaValidateResult,
} from './env-schema-probe.ts';
import {
  collectPlaintextVarWarningsFromVars,
  deriveSelfHostEnvContextFromVars,
  dischargeSelfHostEnvContext,
  fetchRemoteSecretNames,
  formatEnvReport,
  getDeployEnvDefaults,
  readEmittedWorkerVars,
  selfHostSchemaFailureMessage,
  SelfHostEnvValidationError,
  SelfHostFirstDeployError,
  SelfHostSchemaError,
  SelfHostSecretListError,
  validateProdEnv,
  type EmittedWorkerVarsResult,
  type SelfHostSchemaFacts,
} from './env-validation.ts';
import { collectGitDeployMetadata, type GitDeployMetadata } from './git-metadata.ts';
import {
  exchangeGithubOidcForDeployToken,
  isGithubActionsOidcAvailable,
  maskGithubActionsSecret,
} from './github-oidc.ts';
import { lintDestinationSplats, lintDuplicateSources, mergeRoutingRules } from './headers.ts';
import { openDeployLog, type CliLogger } from './log-file.ts';
import { promptForLoginToken } from './login.ts';
import { cliTitle, createSpinner, pc } from './output.ts';
import {
  collectAndHashAssets,
  buildVoidManifest,
  buildStaticManifest,
  buildFrameworkManifest,
  collectWorkerFiles,
  detectNonSpaFallbackWarning,
  getAssetContentType,
  type AssetManifestEntry,
} from './package.ts';
import {
  detectPreset,
  hasBackendFiles,
  FRAMEWORK_PRESETS,
  formatProjectCommand,
  resolveProjectCommand,
  resolveWranglerArgv,
  type StaticPreset,
  type FrameworkPreset,
} from './preset.ts';
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from './project.ts';
import { promptProjectSelection, promptProjectSetupAction } from './prompt.ts';
// The provision module pulls in the whole-provision cross-process lock
// (`proper-lockfile` → `signal-exit`), which patches `process.emit` /
// `process.reallyExit` and installs exit handlers the moment it is imported. An
// ordinary MANAGED `void deploy` never enters the Cloudflare-backend fork, so it
// must not pay that side effect. Keep ONLY erasable `import type` at module scope
// and load the runtime values with a DYNAMIC `import()` inside the fork
// (`loadProvisionModule`), so importing this file (which `cli.ts` does for every
// deploy) never evaluates the provision lifecycle.
import type {
  DesiredResourceSet,
  ProvisionDriftEntry,
  provisionCloudflareResources,
} from './provision.ts';

/** The provision module, loaded lazily inside the Cloudflare fork only. */
type ProvisionModule = typeof import('./provision.ts');
let loadedProvisionModule: ProvisionModule | undefined;

/**
 * Dynamically load the provision module (memoized). Called only from the async
 * Cloudflare fork (`runCloudflareDeploy` / `computeDesiredCloudflareResources`)
 * so a managed deploy never imports it — and thus never loads `proper-lockfile`.
 */
async function loadProvisionModule(): Promise<ProvisionModule> {
  loadedProvisionModule ??= await import('./provision.ts');
  return loadedProvisionModule;
}

/**
 * The provision module after it has been loaded by the fork, for the SYNC helpers
 * (`resolveDeployTransport` / `deployChildEnv` / `createDeployWranglerRunner`)
 * that cannot await. They only ever run after {@link loadProvisionModule} has
 * resolved inside {@link runCloudflareDeploy}, so this never throws in practice.
 */
function requireProvisionModule(): ProvisionModule {
  if (!loadedProvisionModule) {
    throw new Error('internal: provision module accessed before it was loaded');
  }
  return loadedProvisionModule;
}
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';
import type {
  AssetConfig,
  DeployEvent,
  DeployManifest,
  DevRedirectRule,
  HeaderRule,
} from './types.ts';
import {
  readExistingLiveBindingConfig,
  normalizeWranglerCompatibilityFlags,
  ensureWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  writeProvisionedWranglerConfig,
  type LiveBindingConfig,
  type WranglerCompat,
} from './wrangler.ts';
import { needsWrapper, generateWrapper, bundleEntry, cleanupWrapper } from './wrapper.ts';

class DeployEventError extends Error {}
import type { WrapperFeatures } from './wrapper.ts';

export type RunDeployOptions = {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
  debug?: boolean;
  backend?: 'cloudflare';
  provision?: boolean;
};

type DeployDoneEvent = Extract<DeployEvent, { event: 'done' }>;
type StreamDeployResult = DeployDoneEvent;

type ResourceSummary = {
  type?: string;
};

export async function generateDeployWrapperIfNeeded(
  root: string,
  workerDir: string,
  workerMain: string,
  features: WrapperFeatures,
): Promise<boolean> {
  if (!needsWrapper(features)) {
    return false;
  }
  await generateWrapper(workerDir, workerMain, root, features);
  return true;
}

const EMPTY_BINDINGS = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLiveBindingConfigFromDeployment(
  deployment: DeploymentResponse | undefined,
): LiveBindingConfig | undefined {
  if (!deployment?.manifest) {
    return undefined;
  }
  let manifest: DeployManifest;
  try {
    manifest = JSON.parse(deployment.manifest) as DeployManifest;
  } catch {
    return undefined;
  }
  if (
    typeof manifest.live?.bindingName !== 'string' ||
    typeof manifest.live.className !== 'string'
  ) {
    return undefined;
  }
  return {
    bindingName: manifest.live.bindingName,
    className: manifest.live.className,
  };
}

export async function ensurePreviouslyDeployedLiveBindingConfig(
  root: string,
  client: PlatformClient,
  projectId: string,
  cliLog?: CliLogger,
): Promise<boolean> {
  if (readExistingLiveBindingConfig(root)) {
    return false;
  }

  const { deployments, activeDeploymentId } = await client.listDeployments(projectId);
  const live = readLiveBindingConfigFromDeployment(
    deployments.find((deployment) => deployment.id === activeDeploymentId),
  );
  if (!live) {
    return false;
  }

  const synced = syncWranglerBindings(root, { ...EMPTY_BINDINGS, needsLive: true }, { live });
  if (synced) {
    cliLog?.info('live_binding_restored', {
      bindingName: live.bindingName,
      className: live.className,
    });
  }
  return synced;
}

export async function resolveDeployLiveBindingConfig(
  root: string,
  client: PlatformClient,
  projectId: string,
  opts: {
    isFrameworkMode: boolean;
    needsLive: boolean | undefined;
    webSockets: Array<{ bindingName: string; className: string }>;
    sandboxClassName?: string;
    cliLog?: CliLogger;
  },
): Promise<LiveBindingConfig | undefined> {
  if (opts.isFrameworkMode || !opts.needsLive) {
    return undefined;
  }

  await ensurePreviouslyDeployedLiveBindingConfig(root, client, projectId, opts.cliLog);
  return resolveLiveBindingConfig(root, {
    reservedBindings: opts.webSockets.map((route) => route.bindingName),
    reservedClasses: [...opts.webSockets.map((route) => route.className), opts.sandboxClassName],
  });
}

export { resolveAssetConfig } from '../asset-routing.ts';

function getExitCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return 1;
}

export function resolveDeployWranglerCompat(
  root: string,
  config: VoidConfig,
  buildOutputDir: string,
  requirements?: {
    authEnabled?: boolean;
    dialect?: DatabaseDialect;
    needsSandbox?: boolean;
  },
): WranglerCompat | undefined {
  if (isNodeTarget(config.target)) {
    return undefined;
  }
  const compat = ensureWranglerCompat(root, config, buildOutputDir);
  const compatibilityFlags = normalizeWranglerCompatibilityFlags(compat.compatibilityFlags, {
    needsNodejsCompat:
      requirements?.authEnabled === true ||
      requirements?.dialect === 'postgresql' ||
      requirements?.needsSandbox === true,
  });
  return compatibilityFlags === compat.compatibilityFlags
    ? compat
    : { ...compat, compatibilityFlags };
}

export function resolveDeployWorkerMain(
  config: VoidConfig,
  buildOutputDir: string,
): string | undefined {
  if (isNodeTarget(config.target)) {
    return undefined;
  }
  try {
    const wrangler = JSON.parse(readFileSync(join(buildOutputDir, 'wrangler.json'), 'utf-8')) as {
      main?: unknown;
    };
    return typeof wrangler.main === 'string' && wrangler.main.length > 0
      ? wrangler.main
      : undefined;
  } catch {
    return undefined;
  }
}

function assertWorkerMainUploaded(
  workerFiles: Map<string, Buffer>,
  workerMain: string | undefined,
): void {
  if (!workerMain || workerFiles.size === 0) {
    return;
  }
  if (!workerFiles.has(workerMain)) {
    throw new Error(
      `deploy: Worker entry '${workerMain}' from wrangler.json was not found in uploaded worker modules.`,
    );
  }
}

/**
 * Run the full deploy pipeline:
 * 1. Check auth
 * 2. Resolve project + deploy mode
 * 3. Build (if needed)
 * 4. Package output
 * 5. Upload to platform
 * 6. Print live URL
 */
export async function runDeploy(root: string, options?: RunDeployOptions): Promise<void> {
  console.log();
  intro(cliTitle('deploy'));

  const cliLog = openDeployLog({
    mirrorToStderr: options?.debug === true || process.env.VOID_DEPLOY_DEBUG === '1',
  });
  cliLog.info('deploy_start', {
    cwd: root,
    projectSlug: options?.projectSlug,
    dir: options?.dir,
    spa: options?.spa === true ? true : undefined,
    skipBuild: options?.skipBuild === true ? true : undefined,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  try {
    await runDeployInner(root, options, cliLog);
    cliLog.info('deploy_end', { ok: true });
  } catch (err) {
    cliLog.error('deploy_end', err, { ok: false });
    throw err;
  } finally {
    await cliLog.close().catch(() => {});
  }
}

/**
 * Build a child-process environment with the CF Access service-token PAIR
 * removed.
 *
 * The deploy flow spawns UNTRUSTED user build code (`vite build`, framework
 * preset builds, drizzle-kit loading the user schema) which inherits the
 * spawn env. A shared, long-lived CF Access service token is needed only by
 * this CLI's own API client (which captures the Access headers once at
 * construction and reuses them for every request) — never by the build — so it
 * must not survive into those children, or it would leak to arbitrary repo
 * build scripts/plugins.
 *
 * We scrub it on the CHILD env rather than mutating `process.env`: deleting it
 * from the parent also breaks interactive expired-token re-auth, which reads
 * `cfAccessHeaders(process.env)` / the cloudflared pair-guard AFTER the build
 * step. Only the service-token pair is scrubbed; the cloudflared
 * `CF_ACCESS_TOKEN` JWT (dev path) is left untouched.
 */
export function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  return env;
}

/**
 * Deploy-time env selectors that pin the WRONG worker/config out from under the
 * top-level config this flow provisions + preflights. Scrubbed from every child env
 * and fenced in the project dotenv (see below), on top of the provisioner's transport
 * scrub/fence which owns the endpoint-redirect + `CLOUDFLARE_ENV` vars:
 *   - `WRANGLER_CI_OVERRIDE_NAME` — wrangler 4.107 applies it AFTER config load
 *     (`mergeSharedConfigArgs` → `getCIOverrideName()`), REPLACING the upload name, so a
 *     bare `wrangler deploy` uploads a worker whose name the generated-config check never
 *     validated.
 *   - `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — the CF Vite plugin points the build at an
 *     ALTERNATE wrangler config, flattening a different binding set into
 *     `dist/ssr/wrangler.json`.
 */
const DEPLOY_CONFIG_OVERRIDE_ENV_VARS = [
  'WRANGLER_CI_OVERRIDE_NAME',
  'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
] as const;

/**
 * The dotenv files wrangler 4.107 reloads into `process.env` (`override: true`) for
 * the orchestrator's `--env=` calls (`getDefaultEnvFiles("")`), so a repo dotenv here
 * would resurrect `WRANGLER_CI_OVERRIDE_NAME` at the DEPLOY step after the child-env
 * scrub removed it.
 */
const DEPLOY_WRANGLER_DOTENV_FILES = ['.env', '.env.local', '.env.', '.env..local'];

/**
 * The dotenv files Vite's `loadEnv(mode, …)` reads for a production `vite build`
 * (`.env`, `.env.local`, `.env.production`, `.env.production.local`), where the CF Vite
 * plugin picks up `CLOUDFLARE_ENV` / `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — a set
 * DISJOINT from wrangler's `--env=` files, so it is fenced separately for the build.
 */
const DEPLOY_VITE_DOTENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/**
 * FAIL CLOSED when the AMBIENT env selects a non-top-level worker/config for the
 * Cloudflare backend, which deploys the top-level environment of the canonical root
 * config ONLY. `CLOUDFLARE_ENV` picks a named env block (different account/name/bindings);
 * `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` points the build at a different config. We refuse
 * rather than silently deploy a target the drift-check / provision never reasoned about.
 */
function assertNoAmbientConfigOverride(): void {
  const cloudflareEnv = process.env.CLOUDFLARE_ENV;
  if (typeof cloudflareEnv === 'string' && cloudflareEnv.trim().length > 0) {
    throw new Error(
      'CLOUDFLARE_ENV is set. --backend cloudflare deploys the TOP-LEVEL environment of ' +
        'your root wrangler config only (a named environment can carry a different account, ' +
        'worker name, or binding set). Unset CLOUDFLARE_ENV and retry.',
    );
  }
  const configPathOverride = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
  if (typeof configPathOverride === 'string' && configPathOverride.trim().length > 0) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. --backend cloudflare builds from the ' +
        'canonical root wrangler config only. Unset it and retry.',
    );
  }
}

/**
 * FAIL CLOSED when the project's dotenv files declare a deploy-time config-override
 * selector. wrangler / Vite reload dotenv on every command, so a repo dotenv would
 * reintroduce a scrubbed var AFTER the child-env scrub — reselecting the upload worker
 * name (wrangler `--env=` files) or the build's wrangler config (Vite production files).
 * The provisioner's transport fence ({@link assertNoTransportRedirectInProjectDotenv})
 * owns `CLOUDFLARE_ENV` + the endpoint-redirect vars; this closes the deploy-specific
 * name/config-path selectors it does not cover, across BOTH consumers' file sets.
 * Exported for direct unit testing of the file-set + win32 case rule.
 */
export function assertNoConfigOverrideInProjectDotenv(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const caseInsensitive = platform === 'win32';
  const declaresAny = (file: string, names: ReadonlyArray<string>): string | undefined => {
    const rawKeys = scanWranglerDotenvKeys(join(root, file));
    const keys = caseInsensitive ? new Set([...rawKeys].map((key) => key.toLowerCase())) : rawKeys;
    return names.find((name) => keys.has(caseInsensitive ? name.toLowerCase() : name));
  };
  // WRANGLER_CI_OVERRIDE_NAME reaches the DEPLOY step via wrangler's `--env=` dotenv reload.
  for (const file of DEPLOY_WRANGLER_DOTENV_FILES) {
    if (declaresAny(file, ['WRANGLER_CI_OVERRIDE_NAME'])) {
      throw new Error(
        `the project file "${file}" sets WRANGLER_CI_OVERRIDE_NAME, which wrangler reloads on ` +
          `every command and applies AFTER config load to REPLACE the deployed worker name — so ` +
          `\`wrangler deploy\` would upload a worker whose name was never validated. Remove it from ` +
          `"${file}" (set it in your shell/CI only if you truly need a CI name override).`,
      );
    }
  }
  // CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH reach the BUILD via Vite's
  // production `loadEnv`, whose file set is disjoint from wrangler's `--env=` files.
  for (const file of DEPLOY_VITE_DOTENV_FILES) {
    const offender = declaresAny(file, ['CLOUDFLARE_ENV', 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH']);
    if (offender) {
      throw new Error(
        `the project file "${file}" sets ${offender}, which the Cloudflare Vite plugin reads at ` +
          `build time to select a named environment or an ALTERNATE wrangler config — flattening a ` +
          `different binding set into dist/ssr/wrangler.json than this deploy provisioned. Remove ` +
          `${offender} from "${file}".`,
      );
    }
  }
}

/**
 * Resolve + validate the ONE pinned transport for the whole deploy, and FAIL CLOSED
 * on any ambient/dotenv redirect that would move the target out from under the pinned
 * top-level config. Reuses the provisioner's resolver + dotenv fence so provision AND
 * the deploy tail (build / whoami / migrate / deploy) share one source of truth.
 * Returns the single resolved API base URL to pin into every child env.
 */
function resolveDeployTransport(root: string, rootConfig: Record<string, unknown>): string {
  const provision = requireProvisionModule();
  assertNoAmbientConfigOverride();
  provision.assertNoTransportRedirectInProjectDotenv(root);
  assertNoConfigOverrideInProjectDotenv(root);
  return provision.resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(rootConfig, 'compliance_region'),
  );
}

/**
 * Build a child env for an orchestrator-owned wrangler / build invocation. Reuses the
 * provisioner's {@link provisionEnv} (scrubs the CF Access pair + EVERY transport
 * selector incl. `CLOUDFLARE_ENV` + win32 case variants, pins ONE account + API base),
 * then scrubs the deploy-specific config-override selectors on top.
 */
function deployChildEnv(accountId: string, apiBaseUrl: string): NodeJS.ProcessEnv {
  const provision = requireProvisionModule();
  const env = provision.provisionEnv({ accountId, apiBaseUrl });
  for (const name of DEPLOY_CONFIG_OVERRIDE_ENV_VARS) {
    provision.deleteEnvVarCaseAware(env, name);
  }
  // Pin WRANGLER_LOG=log for the whole deploy so wrangler's `d1 migrations list` sentinels
  // ('No migrations to apply!' / 'Migrations to be applied:'), emitted at logger level
  // `log`, are NEVER suppressed by an ambient WRANGLER_LOG=none|error|warn|info — otherwise
  // a declined/partial apply prints no marker and the pending-check would pass open. The
  // canonical spelling is scrubbed case-aware FIRST so no mixed-case ambient value shadows
  // the pin on win32; `log` is wrangler's own default level, so normal output is unchanged.
  provision.deleteEnvVarCaseAware(env, 'WRANGLER_LOG');
  env.WRANGLER_LOG = 'log';
  return env;
}

/** The id-bearing binding fields whose identity must survive the build unchanged. */
const DEPLOY_BINDING_IDENTITY_FIELDS: Record<
  ProvisionDriftEntry['kind'],
  { field: string; idField: string }
> = {
  d1: { field: 'd1_databases', idField: 'database_id' },
  kv: { field: 'kv_namespaces', idField: 'id' },
  r2: { field: 'r2_buckets', idField: 'bucket_name' },
  hyperdrive: { field: 'hyperdrive', idField: 'id' },
};

/** Every id-bearing binding in the desired set, as `{ kind, binding }` pairs. */
function desiredIdentityBindings(
  desired: DesiredResourceSet,
): Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> {
  const out: Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> = [];
  if (desired.d1) {
    out.push({ kind: 'd1', binding: desired.d1.binding });
  }
  for (const kv of desired.kvNamespaces) {
    out.push({ kind: 'kv', binding: kv.binding });
  }
  if (desired.r2) {
    out.push({ kind: 'r2', binding: desired.r2.binding });
  }
  if (desired.hyperdrive) {
    out.push({ kind: 'hyperdrive', binding: desired.hyperdrive.binding });
  }
  return out;
}

/** The CF Vite plugin's deploy-config redirect that a bare `wrangler deploy` follows. */
function deployPointerPath(root: string): string {
  return join(root, '.wrangler', 'deploy', 'config.json');
}

/**
 * Wrangler 4.107's FULL credential env-var set, verified against
 * `wrangler-dist/cli.js`. It covers every env var wrangler reads to authenticate —
 * the API-client auth inputs (`apiToken`/`apiKey`/`apiEmail`/`userServiceKey`) plus
 * the `getEnvironmentVariableFactory` auth tokens — each canonical name AND its
 * deprecated `CF_*` alias:
 *   - API token:            `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN`
 *   - global auth key:      `CLOUDFLARE_API_KEY` / `CF_API_KEY`
 *   - global auth email:    `CLOUDFLARE_EMAIL` / `CF_EMAIL`
 *   - user service key:     `CLOUDFLARE_API_USER_SERVICE_KEY`
 *   - CF authorization tok: `WRANGLER_CF_AUTHORIZATION_TOKEN`
 *   - Access service token: `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`
 * The env-schema probe needs NO credentials, so the whole set is scrubbed from its
 * child env — a leaking env.ts can never read a real credential the parent holds.
 * (`provisionEnv` already scrubs Void's own `CF_ACCESS_CLIENT_ID/SECRET` pair + the
 * account-id selector; this adds the wrangler-account credentials it does not.)
 */
const WRANGLER_AUTH_CREDENTIAL_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
];

/**
 * Build the child env for the isolated env-schema probe. Starts from
 * {@link deployChildEnv} (CF Access + every transport selector scrubbed, one account +
 * API base pinned), then (1) scrubs the FULL wrangler-auth credential set case-aware —
 * the probe needs no credentials — and (2) pins `NODE_ENV=production` so the child
 * evaluates env.ts under the SAME environment the build uses (`vite build` sets
 * `NODE_ENV=production`), keeping the required-key set the probe derives identical to
 * the built worker's. Used by BOTH the pre-build facts probe and the post-build
 * `validate-emitted` probe.
 */
function buildSchemaProbeEnv(accountId: string, apiBaseUrl: string): NodeJS.ProcessEnv {
  const env = deployChildEnv(accountId, apiBaseUrl);
  const provision = requireProvisionModule();
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    provision.deleteEnvVarCaseAware(env, name);
  }
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  provision.deleteEnvVarCaseAware(env, 'NODE_ENV');
  env.NODE_ENV = 'production';
  return env;
}

/**
 * Default {@link CloudflareDeployDeps.resolveSchemaFacts} seam: derive the
 * env-INSENSITIVE schema facts (required-secret NAMES + `.secret()` flags) — and the
 * v1 envDir/mode narrowing — in an ISOLATED SUBPROCESS ({@link
 * resolveEnvSchemaFactsViaSubprocess}) under the scrubbed `env`. The parent runs NO
 * project code: importing the user's env.ts (and resolving the Vite config) happens in
 * the child, so a deferred handler can never read the parent's credentials. Loaded
 * lazily so a managed deploy never pulls the probe in.
 */
async function resolveEnvSchemaFactsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaProbeResult> {
  const { resolveEnvSchemaFactsViaSubprocess } = await import('./env-schema-probe.ts');
  return resolveEnvSchemaFactsViaSubprocess(input, env);
}

/**
 * Default {@link CloudflareDeployDeps.validateEmittedVars} seam: validate the REAL
 * emitted worker `vars` (post-build ground truth) against the schema validators in the
 * SAME isolated subprocess ({@link validateEmittedVarsViaSubprocess}) under the scrubbed
 * `env`, returning the FAILING key NAMES only. Runs the user's validators (project
 * code) off the credentialed parent; loaded lazily so a managed deploy never pulls it in.
 */
async function validateEmittedVarsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaValidateResult> {
  const { validateEmittedVarsViaSubprocess } = await import('./env-schema-probe.ts');
  return validateEmittedVarsViaSubprocess(input, env);
}

/**
 * Clear, values-free guidance for the v1 envDir/mode rejection the facts probe raised
 * (a custom Vite `envDir` or a non-`production` build mode). Rendered from the fixed
 * reason CODE alone — the raw resolved envDir/mode strings never crossed the probe
 * boundary, so nothing here can echo a Vite-config-derived value.
 */
function cloudflareEnvDirModeRejectMessage(
  reject: Extract<EnvSchemaProbeResult, { kind: 'reject' }>,
): string {
  if (reject.reason === 'custom-envdir') {
    return [
      'deploy: --backend cloudflare does not support a custom Vite `envDir` (including `envDir: false`).',
      'v1 loads env from the project root only. The build reads `.env*` from your envDir but',
      'generates the auth schema from the project root, so a custom envDir could validate a',
      'different table set than the worker actually ships. Remove `envDir` from your Vite config',
      '(or point it back at the project root), then rerun — or deploy this app with `void deploy`',
      '(the managed platform).',
    ].join('\n');
  }
  return [
    'deploy: --backend cloudflare builds in production mode only (your build resolves to a non-production mode).',
    'A non-production build mode selects a different `.env.<mode>` set than this backend validates.',
    'Remove the custom `mode` from your Vite config / build command so the build runs in production,',
    'then rerun — or deploy this app with `void deploy` (the managed platform).',
  ].join('\n');
}

/** Re-export so existing importers (and tests) keep reading the type from deploy.ts. */
export type { EmittedWorkerVarsResult };

/**
 * Default {@link CloudflareDeployDeps.readEmittedWorkerVars} seam: read the REAL
 * `vars` map the build baked into `dist/ssr/wrangler.json` (ground truth — the exact
 * plaintext the worker ships). Delegates to the shared {@link readEmittedWorkerVars}
 * reader (also used by the isolated `validate-emitted` probe child), so the parent
 * and the child resolve the SAME artifact.
 */
function readEmittedWorkerVarsDefault(root: string): EmittedWorkerVarsResult {
  return readEmittedWorkerVars(root);
}

/**
 * Remove the CF plugin's deploy pointer before building so the post-build
 * verification can only pass on a pointer THIS build re-created. The CF plugin
 * overwrites (never deletes) it, and only when the CF Vite plugin runs — a build
 * that emits no worker artifact would otherwise leave a stale pointer from a prior
 * run, which a bare `wrangler deploy` would follow to old code.
 */
function removeDeployPointer(root: string): void {
  rmSync(deployPointerPath(root), { force: true });
}

/**
 * Confirm the deploy config the CF Vite plugin emitted targets the pinned account, the
 * expected worker name, AND the exact resources this deploy provisioned — at the
 * TOP-LEVEL environment, BEFORE a bare `wrangler deploy` uploads anything.
 * `wrangler deploy` (no `-c`) follows `.wrangler/deploy/config.json` → the generated
 * `dist/.../wrangler.json`. A `CLOUDFLARE_ENV` / `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`
 * in the ambient env or a production `.env` can make the build FLATTEN a named env or an
 * alternate config into that artifact — keeping the same `account_id`/`name` while
 * swapping the binding set, so `wrangler deploy --env=` ships it as top-level with no
 * mismatch. When `rootConfigPath` + `desired` are given we therefore also assert every
 * desired id-bearing binding's IDENTITY (D1 database_id / KV id / R2 bucket_name /
 * Hyperdrive id) in the generated artifact equals the identity in the canonical root
 * config the drift-check / provision resolved. Returns `{ ok:false, reason }` on any
 * mismatch — or when the config is missing/unreadable — so the caller fails closed.
 */
export function verifyGeneratedDeployConfig(
  root: string,
  expected: {
    accountId: string;
    workerName: string;
    rootConfigPath?: string;
    desired?: DesiredResourceSet;
  },
): { ok: boolean; reason?: string } {
  const deployConfigPath = deployPointerPath(root);
  if (!existsSync(deployConfigPath)) {
    return {
      ok: false,
      reason: `expected the CF plugin's deploy config at ${deployConfigPath}, but it was not written by the build (a stale pointer is removed before building, so only a fresh one from this build is trusted).`,
    };
  }
  let redirectedPath: string;
  try {
    const parsed = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as { configPath?: unknown };
    if (typeof parsed.configPath !== 'string' || parsed.configPath.length === 0) {
      return { ok: false, reason: `${deployConfigPath} has no "configPath" pointer.` };
    }
    redirectedPath = resolve(dirname(deployConfigPath), parsed.configPath);
  } catch {
    return { ok: false, reason: `${deployConfigPath} is not valid JSON.` };
  }
  if (!existsSync(redirectedPath)) {
    return { ok: false, reason: `generated wrangler config ${redirectedPath} does not exist.` };
  }
  let generated: Record<string, unknown>;
  try {
    generated = JSON.parse(readFileSync(redirectedPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `generated wrangler config ${redirectedPath} is not valid JSON.` };
  }
  if (generated.account_id !== expected.accountId) {
    return {
      ok: false,
      reason: `generated config account_id ${JSON.stringify(generated.account_id)} does not match the pinned account ${JSON.stringify(expected.accountId)}.`,
    };
  }
  if (generated.name !== expected.workerName) {
    return {
      ok: false,
      reason: `generated config worker name ${JSON.stringify(generated.name)} does not match the expected worker ${JSON.stringify(expected.workerName)}.`,
    };
  }
  // Binding-identity check: the generated artifact's provisioned resources must be the
  // SAME ones (by id) as the canonical root config. A flattened named-env / alternate
  // config keeps account+name but swaps identities — caught here.
  if (expected.rootConfigPath && expected.desired) {
    const rootConfig = parseRootWranglerConfig(expected.rootConfigPath);
    for (const { kind, binding } of desiredIdentityBindings(expected.desired)) {
      const { field, idField } = DEPLOY_BINDING_IDENTITY_FIELDS[kind];
      const rootId = readStoredResourceName(rootConfig, field, binding, idField);
      // Presence of a real id in root is the drift-check's job; here we only assert the
      // generated artifact did not DIVERGE from whatever the root config resolved.
      if (rootId === undefined) {
        continue;
      }
      const generatedId = readStoredResourceName(generated, field, binding, idField);
      if (generatedId === undefined) {
        return {
          ok: false,
          reason: `generated config is missing the ${field} binding ${JSON.stringify(binding)} (root config provisioned identity ${JSON.stringify(rootId)}) — a named environment or alternate config flattened a different binding set.`,
        };
      }
      if (generatedId !== rootId) {
        return {
          ok: false,
          reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(generatedId)} but the provisioned root config has ${JSON.stringify(rootId)} — refusing to deploy a flattened/alternate binding set.`,
        };
      }
    }
  }
  return { ok: true };
}

/** Result of one orchestrator-owned wrangler invocation (whoami/migrate/deploy). */
export type DeployWranglerRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  /** Non-null ONLY when the child was killed by a signal — a HARD failure. */
  signal?: NodeJS.Signals | null;
  /** Spawn-error message when the child could not start — a HARD failure. */
  error?: string | null;
};

/**
 * Injectable seam over the orchestrator's OWN wrangler calls (`whoami`,
 * `d1 migrations apply`, `deploy`). `capture:true` pipes stdout/stderr (so
 * `whoami --json` can be classified); `capture:false` inherits the terminal
 * (migrate/deploy stream their own progress + URL). Unit tests inject a stub so
 * no real wrangler runs. Mirrors the provisioner's `RunWrangler` structured
 * provenance so a signal-killed / unspawnable child is never read as success.
 */
export type DeployWranglerRun = (
  args: Array<string>,
  opts: { capture: boolean },
) => DeployWranglerRunResult | Promise<DeployWranglerRunResult>;

/**
 * Injectable seams for {@link runCloudflareDeploy}, so the whole orchestration
 * is unit-testable with NO real wrangler / network / Cloudflare account — the
 * same pattern the provisioner (`cli/provision.ts`) and the self-host secret
 * units (`cli/env-validation.ts`) use.
 */
export interface CloudflareDeployDeps {
  /** wrangler runner for the orchestrator's own whoami/migrate/deploy calls. */
  runWrangler?: DeployWranglerRun;
  /** Run the project's `vite build` (inherited stdio). Throws on a nonzero build. */
  runBuild?: (env: NodeJS.ProcessEnv) => void;
  /** Provisioner seam (default: `provisionCloudflareResources`, loaded dynamically). */
  provision?: typeof provisionCloudflareResources;
  /** Parent-side secret-gate discharge seam (default: {@link dischargeSelfHostEnvContext}). */
  dischargeSelfHostEnv?: typeof dischargeSelfHostEnvContext;
  /** Generated-deploy-config verification seam (default: {@link verifyGeneratedDeployConfig}). */
  verifyDeployConfig?: typeof verifyGeneratedDeployConfig;
  /** Pre-remote-migrate gate seam (default: {@link assertRemoteMigrationsDeployable}). */
  assertMigrationsDeployable?: typeof assertRemoteMigrationsDeployable;
  /** Migration apply-set equality gate seam (default: {@link checkWranglerMigrationApplySet}). */
  checkMigrationApplySet?: typeof checkWranglerMigrationApplySet;
  /**
   * Auth-schema validation seam (default: {@link validateAuthMigrationSchema}).
   * Runs POST-build: reads the generated auth schema the build emitted
   * (`.void/better-auth-schema.ts`) and asserts the checked-in migrations produce it.
   */
  validateAuthMigrations?: typeof validateAuthMigrationSchema;
  /**
   * Isolated env-schema probe seam (default: the {@link EnvSchemaProbeInput}
   * subprocess). Receives a scrubbed env and returns the env-INSENSITIVE schema facts
   * (required-secret NAMES + `.secret()` flags), derived by importing env.ts in the
   * child, so the parent runs no project code. A `schema-error` (env.ts failed to
   * evaluate, or a validator threw) fails the deploy closed.
   */
  resolveSchemaFacts?: (
    input: EnvSchemaProbeInput,
    env: NodeJS.ProcessEnv,
  ) => EnvSchemaProbeResult | Promise<EnvSchemaProbeResult>;
  /**
   * Isolated emitted-var validation seam (default: the {@link EnvSchemaProbeInput}
   * subprocess in `validate-emitted` mode). Runs POST-build: validates the REAL emitted
   * worker `vars` against the schema's validators in the child and returns the FAILING
   * key NAMES only, which fold into the secret-gate context so a malformed required
   * value fails the deploy closed before any remote mutation.
   */
  validateEmittedVars?: (
    input: EnvSchemaProbeInput,
    env: NodeJS.ProcessEnv,
  ) => EnvSchemaValidateResult | Promise<EnvSchemaValidateResult>;
  /**
   * Emitted-worker-vars read seam (default: {@link readEmittedWorkerVarsDefault}).
   * Runs POST-build: reads the REAL `vars` map the build baked into
   * `dist/ssr/wrangler.json` — the ground truth the plaintext warnings + secret gate
   * validate.
   */
  readEmittedWorkerVars?: (root: string) => EmittedWorkerVarsResult;
  /** Override CI / non-interactive detection (default: `!stdin.isTTY || getTokenSource()==='ci'`). */
  isCI?: boolean;
  /** Override `process.exit` (tests assert the exit code without halting). */
  exit?: (code: number) => never;
}

/** Human labels for a drifted resource kind, used in guidance messages. */
const CLOUDFLARE_RESOURCE_LABELS: Record<ProvisionDriftEntry['kind'], string> = {
  d1: 'D1 database',
  kv: 'KV namespace',
  r2: 'R2 bucket',
  hyperdrive: 'Hyperdrive config',
};

/** True only for a wrangler child that ran to completion with a clean exit 0. */
function isCleanWranglerExit(result: DeployWranglerRunResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

/**
 * Parse the root wrangler config (BOM-aware, trailing commas allowed), matching
 * the provisioner's `readRootConfig`. Returns `{}` when the file is absent or
 * unreadable — callers then treat every field as unset (safe: a genuinely broken
 * config fails later in wrangler with a clear error).
 */
function parseRootWranglerConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }
  const content = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const errors: Array<ParseError> = [];
  const parsed = parseJsoncConfig(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/** Read a non-empty top-level string field (`account_id` / `name`) from the config. */
function readWranglerTopLevelString(
  config: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = config[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read the stored resource name (`database_name` / `bucket_name`) for a binding. */
function readStoredResourceName(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  nameField: string,
): string | undefined {
  const list = config[field];
  if (!Array.isArray(list)) {
    return undefined;
  }
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { binding?: unknown }).binding === binding
    ) {
      const name = (entry as Record<string, unknown>)[nameField];
      return typeof name === 'string' && name.length > 0 ? name : undefined;
    }
  }
  return undefined;
}

/**
 * Whether a resource binding DECLARES a field at all — present with ANY defined
 * value, INCLUDING an empty string. Distinct from {@link readStoredResourceName}
 * (which collapses both "absent" and "empty string" to `undefined`): a
 * present-but-empty `migrations_pattern: ""` is still a CUSTOM pattern — wrangler
 * 4.107 takes its non-default branch for any value that is not `undefined`
 * (`rawPattern !== void 0`), so an empty pattern diverges from the default flat
 * `*.sql` enumeration this backend validates against. v1 therefore rejects a
 * custom pattern on PRESENCE, not on a non-empty length. Returns the raw value so
 * the caller can name it (never a secret — a wrangler config field).
 */
function readBindingFieldPresence(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  key: string,
): { present: boolean; value: unknown } {
  const list = config[field];
  if (!Array.isArray(list)) {
    return { present: false, value: undefined };
  }
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { binding?: unknown }).binding === binding
    ) {
      return Object.hasOwn(entry as object, key)
        ? { present: true, value: (entry as Record<string, unknown>)[key] }
        : { present: false, value: undefined };
    }
  }
  return { present: false, value: undefined };
}

/** Read a `d1_databases` entry's string field. */
function readD1EntryString(entry: unknown, field: string): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the token to pass to `wrangler d1 migrations apply` so wrangler's OWN
 * resolution (`getDatabaseInfoFromConfig`, wrangler 4.107 src/d1/utils.ts) selects
 * EXACTLY the `d1_databases` entry the gate validated (matched by `binding`). wrangler
 * iterates the array and returns the FIRST entry where
 * `token === database_name || token === binding`, then uses that entry's `migrations_dir`.
 * We prefer the validated entry's own `database_name` as the token (falling back to the
 * binding), and FAIL CLOSED when an EARLIER entry also matches it — because wrangler would
 * then select the earlier entry (a different DB / an unrelated migrations folder) though
 * the gate validated ours.
 */
function resolveD1MigrateTarget(
  config: Record<string, unknown>,
  binding: string,
): { ok: true; token: string } | { ok: false; reason: string } {
  const list = config.d1_databases;
  if (!Array.isArray(list)) {
    return { ok: false, reason: `the root config has no "d1_databases" array` };
  }
  const validatedIndex = list.findIndex((entry) => readD1EntryString(entry, 'binding') === binding);
  if (validatedIndex === -1) {
    return { ok: false, reason: `no d1_databases entry has binding ${JSON.stringify(binding)}` };
  }
  const validated = list[validatedIndex];
  // wrangler matches by database_name OR binding; the validated entry always matches its
  // own binding, so the binding is a safe fallback token when it has no database_name.
  const token = readD1EntryString(validated, 'database_name') ?? binding;
  for (let i = 0; i < validatedIndex; i++) {
    const earlier = list[i];
    if (
      readD1EntryString(earlier, 'database_name') === token ||
      readD1EntryString(earlier, 'binding') === token
    ) {
      return {
        ok: false,
        reason:
          `an earlier d1_databases entry (binding ${JSON.stringify(readD1EntryString(earlier, 'binding'))}, ` +
          `database_name ${JSON.stringify(readD1EntryString(earlier, 'database_name'))}) also matches the ` +
          `token ${JSON.stringify(token)}, so wrangler would migrate it instead`,
      };
    }
  }
  return { ok: true, token };
}

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
    .slice(0, 63)
    .replace(/-+$/g, '');
  return name.length > 0 ? name : 'my-worker';
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
function deriveWorkerName(root: string): string {
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
 * Compute the DESIRED id/name-bearing Cloudflare resources from SOURCE
 * (pre-build, fail-fast) — the single set shared by the provision and drift
 * paths. Reuses the deploy-time inference primitives directly
 * (`inferProjectBindings` + the scanners + the pg-dialect / `hasRevalidate`
 * signals) rather than `assembleVoidManifest`, which runs only inside the
 * managed `runFullDeploy` branches that need a `PlatformClient`.
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
}> {
  // `isRealD1Id` is resolved via the memoized dynamic import so this exported
  // helper works when called directly in unit tests (outside the fork) without a
  // static provision edge that would eagerly load the provision lifecycle.
  const { isRealD1Id } = await loadProvisionModule();
  const paths = resolveProjectPaths(root, voidConfig);
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name') ?? deriveWorkerName(root);

  // Match runFullDeploy's inference: framework (Class-A) apps expand the scan
  // dirs so bindings used in framework-specific dirs are still discovered.
  const isFrameworkMode = detectFramework(root) != null;
  const scanDirs =
    voidConfig.inference?.scanDirs ?? (isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined);
  // Mirror voidPlugin's inference options EXACTLY (index.ts): when `void.json`
  // declares `inference.bindings`, those explicit overrides (forced `true`, a
  // custom binding name, or disabled `false`) drive the build — so the desired set
  // must consume the same overrides, or a `false` override would still provision a
  // binding the build never emits (and a forced/custom one would be missed).
  const inferenceOptions = voidConfig.inference?.bindings
    ? { bindings: voidConfig.inference.bindings }
    : undefined;
  const bindings = inferProjectBindings(root, { ...inferenceOptions, paths }, scanDirs);
  const authEnabled =
    bindings.needsAuth || findVoidAuthConfig(root, paths) !== null || voidConfig.auth !== undefined;
  const dialect = getDatabaseDialect(voidConfig);
  const bindingNames = resolveBindingNames(voidConfig.inference?.bindings);
  // Checked-in migrations count toward the database gate, matching the managed
  // manifest (`buildVoidManifest`: `needsD1 || needsAuth || hasMigrations`). Without
  // this a migration-only SQLite app would provision no D1 and silently skip remote
  // migrations. Collected ONCE pre-build from `db/migrations/` (sourceDir-aware) and
  // carried through so the migrate step can skip when there are none and run the
  // deploy gates on the exact same files.
  const migrations = collectMigrations(paths.migrationsDir);
  const hasMigrations = migrations.length > 0;
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
  // vs Hyperdrive (postgresql). This keeps provision/drift equivalent to the build:
  // a migration-only SQLite app still provisions D1, and an unused pg config does
  // not needlessly require Hyperdrive.
  const needsDatabase = bindings.needsD1 || authEnabled || hasMigrations;
  const databaseReason = bindings.needsD1
    ? 'app uses env.DB (D1)'
    : authEnabled
      ? 'auth requires a D1 database'
      : 'checked-in migrations need a D1 database';
  if (needsDatabase && dialect !== 'postgresql') {
    const binding = bindingNames?.d1 ?? 'DB';
    // Trust a stored `database_name` ONLY when the paired `database_id` is a REAL
    // (non-placeholder) id. A synced-but-unprovisioned entry carries the local
    // placeholder id `"local"` (often alongside `database_name: "default"`); trusting
    // that name would provision/adopt an account-wide DB literally named `default`.
    const storedName = readStoredResourceName(config, 'd1_databases', binding, 'database_name');
    const storedId = readStoredResourceName(config, 'd1_databases', binding, 'database_id');
    const name =
      storedName != null && isRealD1Id(storedId)
        ? storedName
        : toValidWorkerName(`${workerName}-db`);
    // Carry the sourceDir-aware config-relative migrations dir so the provisioner
    // writes the correct `migrations_dir` (it otherwise hardcodes `./db/migrations`).
    desired.d1 = { binding, name, migrationsDir: migrationsDirRelative };
    reasons.set(binding, databaseReason);
  }

  // KV
  if (bindings.needsKV) {
    const binding = bindingNames?.kv ?? 'KV';
    desired.kvNamespaces.push({ binding, title: toValidWorkerName(`${workerName}-kv`) });
    reasons.set(binding, 'app uses env.KV');
  }

  // R2
  if (bindings.needsR2) {
    const binding = bindingNames?.r2 ?? 'STORAGE';
    const storedName = readStoredResourceName(config, 'r2_buckets', binding, 'bucket_name');
    const bucketName =
      storedName && storedName !== 'default'
        ? storedName
        : toValidWorkerName(`${workerName}-storage`);
    desired.r2 = { binding, bucketName };
    reasons.set(binding, 'app uses env.STORAGE (R2)');
  }

  // Queues (resource names — account-unique; the build binds them for native apps).
  desired.queues = scanQueuesSync(root, paths.queuesDir).map((q) => q.name);

  // Hyperdrive (PostgreSQL apps) — same database gate as D1, dialect-selected. The
  // connection string is only consumed on a fresh create; a re-provision reads-first
  // from the config id and never needs it.
  if (needsDatabase && dialect === 'postgresql') {
    const binding = 'HYPERDRIVE';
    desired.hyperdrive = {
      binding,
      name: toValidWorkerName(`${workerName}-hyperdrive`),
      connectionString: process.env.DATABASE_URL ?? '',
    };
    reasons.set(binding, 'app uses PostgreSQL (needs a Hyperdrive config)');
  }

  // ISR_CACHE (a KV namespace) — self-host-only, not in the import walk. Desired
  // when the merged revalidate config (void.json `routing.revalidate` + per-page
  // `export const revalidate`) turns ISR on — the SAME gate the build's `emitIsr`
  // uses (`plugin-routing.ts`).
  const pageScan = existsSync(paths.pagesDir)
    ? await scanPages(root, { output: voidConfig.output, paths })
    : null;
  if (hasRevalidate(collectRevalidate(voidConfig, pageScan))) {
    const binding = 'ISR_CACHE';
    desired.kvNamespaces.push({ binding, title: toValidWorkerName(`${workerName}-isr-cache`) });
    reasons.set(binding, 'routes use `revalidate` (ISR) — needs an ISR_CACHE KV namespace');
  }

  return {
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir: paths.migrationsDir,
    migrations,
  };
}

/**
 * Apply the checked-in migrations to an in-memory SQLite database (`node:sqlite`, a repo
 * dependency — the same driver `auth/node.ts` uses) and assert the effective schema contains
 * every REQUIRED auth table and its columns. This replaces a raw `CREATE TABLE` token search
 * (defeated by comments/strings/renames/plugin tables) with the real POST-migration schema —
 * the identical thing wrangler will apply to remote D1 (SQLite). Throws with the exact
 * missing table(s)/column(s), or when a migration cannot even be applied. Exported for unit
 * testing (the `required` set is passed in, so this needs no Better Auth resolution).
 */
export async function assertMigrationsProduceAuthSchema(
  migrations: Array<{ name: string; sql: string }>,
  required: Array<{ table: string; columns: Array<string> }>,
): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of migrations) {
      try {
        db.exec(migration.sql);
      } catch (err) {
        throw new Error(
          `checked-in migration ${migration.name} could not be applied to a fresh SQLite database, ` +
            `so the auth schema cannot be verified: ${getErrorMessage(err)}`,
        );
      }
    }
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const problems: Array<string> = [];
    for (const req of required) {
      if (!tables.has(req.table)) {
        problems.push(`table "${req.table}" is not created by any checked-in migration`);
        continue;
      }
      const columns = new Set(
        (
          db.prepare(`PRAGMA table_info("${req.table.replace(/"/g, '""')}")`).all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      const missing = req.columns.filter((column) => !columns.has(column));
      if (missing.length > 0) {
        problems.push(`table "${req.table}" is missing column(s): ${missing.join(', ')}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(problems.join('; '));
    }
  } finally {
    db.close();
  }
}

/**
 * Read the REQUIRED Better Auth schema (tables + columns) from the schema the BUILD
 * actually generated — ground truth, not a facsimile. `writeAuthDatabaseFiles`
 * (plugin-routing.ts) emits `<root>/.void/better-auth-schema.ts` during the build,
 * containing an `export const migrationSchema = { ... } as const;` literal —
 * `JSON.stringify(resolveVoidAuthMigrationSchema(...), null, 2)` derived under the
 * build's real mode, so it already reflects configured table/column RENAMES + PLUGIN
 * tables. The literal's top-level object closes with `}` at column 0, so the
 * `\n} as const;` terminator uniquely bounds the JSON (inner braces are indented).
 * The `id` column is the implicit PRIMARY KEY, so it is prepended to each table's
 * columns — matching `resolveVoidAuthMigrationSchema`'s field set exactly. Throws a
 * fail-closed error when the artifact is missing/malformed.
 */
function readEmittedAuthMigrationSchema(
  root: string,
): Array<{ table: string; columns: Array<string> }> {
  const schemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (!existsSync(schemaPath)) {
    throw new Error(
      `the build did not emit ${schemaPath}, so the generated auth schema could not be read from the build output.`,
    );
  }
  const content = readFileSync(schemaPath, 'utf-8');
  const marker = 'export const migrationSchema = ';
  const start = content.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `${schemaPath} has no migrationSchema literal — cannot verify the auth schema.`,
    );
  }
  const jsonStart = start + marker.length;
  const end = content.indexOf('\n} as const;', jsonStart);
  if (end === -1) {
    throw new Error(
      `${schemaPath} migrationSchema literal is malformed — cannot verify the auth schema.`,
    );
  }
  let migrationSchema: VoidAuthMigrationSchema;
  try {
    migrationSchema = JSON.parse(content.slice(jsonStart, end + 2)) as VoidAuthMigrationSchema;
  } catch {
    throw new Error(
      `${schemaPath} migrationSchema is not valid JSON — cannot verify the auth schema.`,
    );
  }
  return migrationSchema.tables.map((table) => ({
    table: table.name,
    columns: ['id', ...Object.keys(table.fields)],
  }));
}

/**
 * Default {@link CloudflareDeployDeps.validateAuthMigrations} seam: read the auth
 * schema the BUILD generated ({@link readEmittedAuthMigrationSchema}) and assert the
 * checked-in migrations produce it (applied to in-memory SQLite). Runs POST-build,
 * against ground truth — no auth-config subprocess, no mode/envDir divergence.
 * Throws on any missing table/column (or an unapplyable migration); the caller
 * renders `.message` + fails closed.
 */
export async function validateAuthMigrationSchema(
  root: string,
  migrations: Array<{ name: string; sql: string }>,
): Promise<void> {
  const required = readEmittedAuthMigrationSchema(root);
  await assertMigrationsProduceAuthSchema(migrations, required);
}

/** Format the drift / CI-gate guidance naming each un-provisioned resource. */
function formatCloudflareDriftMessage(
  missing: Array<ProvisionDriftEntry>,
  reasons: Map<string, string>,
  header: string,
  footer: string,
): string {
  const lines = missing.map((entry) => {
    const reason = reasons.get(entry.binding);
    const label = CLOUDFLARE_RESOURCE_LABELS[entry.kind];
    return `  • ${entry.binding} (${label})${reason ? ` — ${reason}` : ''}`;
  });
  return [header, ...lines, '', footer].join('\n');
}

/**
 * Run the SAME migration validations the MANAGED deploy runs before applying
 * migrations to remote D1 — schema drift (drizzle-kit), journal coherence, and
 * destructive-op-without-pragma — reusing the managed building blocks
 * ({@link hasDeploySchemaDrift} / {@link getDeploySchemaDriftMessage} /
 * `assertJournalCoherence` / `validateMigrations`). Unlike the managed
 * `assertDeploySchemaDriftFree` (which calls `process.exit` itself), this THROWS on
 * any failure so the Cloudflare orchestrator routes the exit through its injectable
 * seam. This is the default of the {@link CloudflareDeployDeps.assertMigrationsDeployable}
 * seam; tests inject a stub to avoid spawning drizzle-kit.
 */
export function assertRemoteMigrationsDeployable(
  root: string,
  dialect: DatabaseDialect,
  migrationsDir: string,
  migrations: Array<{ name: string; sql: string }>,
): void {
  if (hasDeploySchemaDrift(root, dialect)) {
    throw new Error(getDeploySchemaDriftMessage());
  }
  assertJournalCoherence(migrationsDir, migrations);
  if (migrations.length > 0) {
    validateMigrations(migrations);
  }
}

/**
 * wrangler 4.107's own migration-file order comparator, reproduced EXACTLY
 * (`compareMigrationPaths` / `compareSegments` / `leadingMigrationNumber`,
 * `wrangler-dist/cli.js` `src/d1/migrations/helpers.ts`): segment-by-segment, comparing each
 * segment's LEADING NUMERIC PREFIX (`parseInt(segment.split('_')[0], 10)`) numerically first,
 * so `2_x.sql` sorts BEFORE `10_x.sql` (lexicographic would invert them). A finite number
 * sorts before a non-numeric segment; equal/both-NaN falls back to lexicographic. This is the
 * exact order `d1 migrations apply` walks (`listFilesRelative(...).sort(compareMigrationPaths)`
 * → `getMigrationNames`), so ordering the gated set the same way tells us what remote D1 will
 * receive, in what order.
 */
function leadingWranglerMigrationNumber(relativePath: string): number {
  const firstSegment = relativePath.split('/')[0] ?? '';
  return parseInt(firstSegment.split('_')[0] ?? '', 10);
}

function compareWranglerMigrationSegments(a: string, b: string): number {
  const aNum = leadingWranglerMigrationNumber(a);
  const bNum = leadingWranglerMigrationNumber(b);
  if (aNum !== bNum) {
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    if (Number.isFinite(aNum)) {
      return -1;
    }
    if (Number.isFinite(bNum)) {
      return 1;
    }
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function compareWranglerMigrationPaths(a: string, b: string): number {
  const aSegments = a.split('/');
  const bSegments = b.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareWranglerMigrationSegments(aSegments[i] as string, bSegments[i] as string);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return aSegments.length - bSegments.length;
}

/**
 * Assert the migration files wrangler 4.107 will APPLY — in the ORDER it applies them — equal
 * the gated source set. wrangler resolves its OWN files from the D1 entry's `migrations_dir`
 * (relative to the config-file dir) with the DEFAULT pattern `<dir>/*.sql` (a custom
 * `migrations_pattern` is rejected pre-account, so only the default flat `*.sql` enumeration —
 * top-level, `{ dot:false }` — reaches here), tracks each by its `.sql` name, and applies them
 * sorted by its numeric-prefix comparator ({@link compareWranglerMigrationPaths}) — the exact
 * sequence `d1 migrations apply` runs against REMOTE D1. This backend VALIDATES the set
 * `collectMigrations` reads (flat dir, `seed.sql` excluded, sorted lexicographically). Two
 * things must hold: (1) SET equality by name AND content — a stray/extra file (e.g. `seed.sql`,
 * which `collectMigrations` skips but wrangler's `*.sql` matches), a differing dir, or a
 * divergent content would otherwise be applied UNVALIDATED; and (2) ORDER parity — the numeric
 * order wrangler applies must equal Void's gated order position-for-position, so the local
 * runner + deploy gates validate the exact order remote D1 receives (an unpadded prefix like
 * `2_` vs `10_` sorts differently lexicographically-vs-numerically and diverges — reject). A
 * defensive custom-pattern check fails closed if one slips past the pre-account guard. Exported
 * for unit testing.
 */
export async function checkWranglerMigrationApplySet(
  configPath: string,
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
  gated: Array<{ name: string; sql: string }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const absDir = resolve(dirname(configPath), migrationsDirRaw);
  if (!existsSync(absDir)) {
    return {
      ok: false,
      reason:
        `deploy: configured migrations_dir ${JSON.stringify(migrationsDirRaw)} resolves to ` +
        `${absDir}, which does not exist — wrangler would have nothing to apply (or error). ` +
        `Align "migrations_dir" with your db/migrations, then rerun.`,
    };
  }
  // Defense in depth: a custom migrations_pattern is rejected pre-account (v1 = default
  // convention only). If one reaches here, fail closed rather than assume the flat `*.sql`.
  // Reject on PRESENCE (any defined value, incl. `""`): a present-but-empty pattern is
  // still non-default to wrangler, and it would otherwise be indistinguishable from absent.
  const migrationsPattern = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_pattern',
  );
  if (migrationsPattern.present) {
    return {
      ok: false,
      reason:
        `deploy: a custom migrations_pattern (${JSON.stringify(migrationsPattern.value)}) is not ` +
        `supported — v1 deploys only the default db/migrations/*.sql convention. Remove it, then rerun.`,
    };
  }
  // wrangler's DEFAULT enumeration: top-level `.sql` files, dotfiles excluded (Minimatch
  // `*.sql` with `{ dot:false }` never crosses `/`, so `meta/` is not walked), APPLIED in
  // wrangler's numeric-prefix order.
  const wranglerNames = readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.startsWith('.'))
    .map((entry) => entry.name.replace(/\\/g, '/'))
    .sort(compareWranglerMigrationPaths);
  const wranglerContent = new Map(
    wranglerNames.map((name) => [name, readFileSync(join(absDir, name), 'utf-8')]),
  );
  const gatedNames = gated.map((m) => m.name.replace(/\\/g, '/'));
  const gatedContent = new Map(gatedNames.map((name, i) => [name, gated[i]!.sql]));

  // 1) SET equality by name + content.
  const wranglerSet = new Set(wranglerNames);
  const extra = wranglerNames.filter((k) => !gatedContent.has(k));
  const missing = gatedNames.filter((k) => !wranglerSet.has(k)).sort();
  const changed = wranglerNames.filter(
    (k) => gatedContent.has(k) && gatedContent.get(k) !== wranglerContent.get(k),
  );
  if (extra.length > 0 || missing.length > 0 || changed.length > 0) {
    const lines = [
      `deploy: the migrations wrangler would apply to remote D1 do not match Void's validated set (${absDir}).`,
    ];
    if (extra.length > 0) {
      lines.push(`  • wrangler would ALSO apply (not validated by Void): ${extra.join(', ')}`);
    }
    if (missing.length > 0) {
      lines.push(`  • validated by Void but NOT in wrangler's set: ${missing.join(', ')}`);
    }
    if (changed.length > 0) {
      lines.push(`  • content differs between Void's copy and wrangler's: ${changed.join(', ')}`);
    }
    lines.push(
      'Only Void-managed db/migrations/*.sql may be applied. Remove stray .sql (e.g. seed.sql) ' +
        'from migrations_dir, then rerun.',
    );
    return { ok: false, reason: lines.join('\n') };
  }

  // 2) ORDER parity — wrangler's numeric apply order must equal Void's gated (collectMigrations)
  // order position-for-position, so the order remote D1 receives is the order Void validated.
  const orderDiffers =
    gatedNames.length !== wranglerNames.length ||
    gatedNames.some((name, i) => name !== wranglerNames[i]);
  if (orderDiffers) {
    return {
      ok: false,
      reason: [
        `deploy: wrangler would apply your migrations in a DIFFERENT order than Void validated (${absDir}).`,
        `  • wrangler (numeric-prefix) order: ${wranglerNames.join(', ')}`,
        `  • Void's validated order:          ${gatedNames.join(', ')}`,
        "This happens when a migration's numeric prefix is not zero-padded (e.g. `2_` vs `10_`),",
        'so it sorts differently for wrangler (numeric) than for Void (lexicographic) — remote D1',
        'would receive them out of the validated order. Zero-pad the prefixes (0001_, 0002_, …),',
        'e.g. with `void db rename-migrations`, then rerun.',
      ].join('\n'),
    };
  }

  return { ok: true };
}

/**
 * Default {@link DeployWranglerRun}: spawns the project-local wrangler REAL CLI
 * (via {@link resolveWranglerArgv}, shell-free) with ONE pinned transport in the
 * child env (via {@link deployChildEnv} — reused provisioner scrub/pin: CF Access +
 * every transport selector incl. `CLOUDFLARE_ENV` + the deploy config-override vars
 * scrubbed, one account + API base pinned), so `whoami`/`migrate`/`deploy` can never
 * consult a different ambient account or endpoint. `capture` pipes or inherits stdio.
 */
function createDeployWranglerRunner(
  root: string,
  accountId: string,
  apiBaseUrl: string,
): DeployWranglerRun {
  const launcher = resolveWranglerArgv(root);
  const [command, ...prefix] = launcher;
  return (args, opts) => {
    const childEnv = deployChildEnv(accountId, apiBaseUrl);
    const result = spawnSync(command as string, [...prefix, ...args], {
      cwd: root,
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      encoding: 'utf-8',
      env: childEnv,
      shell: false,
      windowsHide: true,
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      signal: result.signal ?? null,
      error: result.error ? result.error.message : null,
    };
  };
}

/**
 * Deploy to the user's OWN Cloudflare account (no Void platform).
 *
 * Orchestrates the existing units — it does NOT re-implement provisioning
 * (`cli/provision.ts`), the config writer (`cli/wrangler.ts`), or the self-host
 * secret preflight (`cli/env-validation.ts`). Flow:
 *
 *   app-class guard → desired set (from source, pre-build) → preflight (auth +
 *   account pin + CI gate) → provision OR drift-check → ensure worker name →
 *   remote D1 migrate → secrets (warn + gate) → clean-env build → wrangler deploy
 *
 * ORDERING DECISION (documented): the secrets GATE runs AFTER provision + remote
 * migrations resolve but BEFORE build + deploy — the brief's recommended default.
 * Provision and D1 migrations are idempotent (read-first / tracked in wrangler's
 * `d1_migrations` table), so re-running them after a gate failure is safe, while
 * build + `wrangler deploy` (the non-idempotent worker upload) is what the gate
 * protects. The warning is emitted first (non-fatal); a first-deploy secret-list
 * failure (worker not yet created) renders actionable `wrangler secret put`
 * bootstrap guidance rather than dead-ending.
 *
 * Every wrangler / provisioner / secret-unit call is an injected seam
 * ({@link CloudflareDeployDeps}) so the whole orchestration is unit-testable with
 * no real wrangler, network, or Cloudflare account.
 */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const voidConfig = readConfig(root);
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  // Load the provision module ONCE, dynamically, so the sync deploy helpers can
  // reach its transport/drift/scrub primitives without a static import that would
  // make every managed `void deploy` eagerly load the provision lifecycle. Awaited
  // here BEFORE any sync helper that calls `requireProvisionModule()`.
  const provisionModule = await loadProvisionModule();

  // 1. App-class narrowing — v1 of `--backend cloudflare` supports ONE well-understood
  // shape: a FULL VOID APP (worker-bearing, running `routingPlugin`) on the Cloudflare
  // Workers target, with D1/KV/R2/Queues/Hyperdrive and — on D1/SQLite — auth + ISR.
  // Everything else FAILS CLOSED here, BEFORE any account / preflight / provision / build
  // op, reusing the SAME classifiers the managed deploy path uses (`detectPreset` +
  // `detectFramework`) so this fork can never disagree with the build about what the app is.

  // 1a. Target guard — this backend deploys Cloudflare Workers ONLY. A node/bun/deno target
  // builds a non-CF worker; reject before the desired set or any account operation.
  if (isNodeTarget(voidConfig.target)) {
    log.error(
      [
        `deploy: --backend cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --backend cloudflare.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 1b. Framework guard — v1 defers the ENTIRE framework SSR path (every class). Class A
  // (tanstack-start / react-router / vinext) composes the Void CF stack but the framework
  // owns its own entry + routing; Class B/C (sveltekit / nuxt / analog / astro) build
  // through their own adapter with NO CF Vite plugin, so `vite build` emits no worker
  // artifact here. Rejecting all of them leaves exactly one supported class — the full Void
  // app that runs `routingPlugin` and emits ISR coherently — so this fork never has to
  // reason about framework wiring. Checked before the static guard so a framework app with
  // no Void backend dirs gets the framework message, not a misleading static one.
  const framework = detectFramework(root);
  if (framework) {
    log.error(
      [
        `deploy: --backend cloudflare does not yet support framework SSR (${framework.name}).`,
        'v1 deploys full Void apps only. Deploy this framework with `void deploy` (the managed',
        'platform) or the framework’s own Cloudflare adapter. Framework SSR support for this',
        'backend is a follow-up.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 1c. Static / SPA / SSG guard — reuse the MANAGED path's own classifier `detectPreset`
  // (NOT `resolveStaticDeployPreset`, whose fallback fires only for an explicit `--dir` or a
  // configured `inference.appType`, so an UNCONFIGURED static/SPA/SSG app slips past it).
  // `detectPreset` structurally detects an SSG dep, a Vite-only SPA, and prebuilt html; the
  // explicit `--dir` / `--spa` intents and a configured static appType are checked alongside
  // it (a configured-but-not-yet-built static app has no structural marker for `detectPreset`).
  // `voidConfig.output === 'static'` is the SSG signal the BUILD itself branches on
  // (index.ts `void:env` skips worker minify + prerenders the SSR bundle for it, deploy.ts
  // `deployConfig.output === 'static'` takes the static-asset path). A pages/ project with
  // `output: "static"` satisfies `hasBackendFiles` and yields a `null` `detectPreset`, so
  // without this signal it would slip past the guard and reach account/build as if it were a
  // full worker app — include it in the reject.
  const staticPreset = detectPreset(root, { dir: options.dir, spa: options.spa });
  const configuredStatic =
    voidConfig.inference?.appType === 'static' ||
    voidConfig.inference?.appType === 'spa' ||
    voidConfig.output === 'static';
  if (staticPreset || configuredStatic || options.dir || options.spa) {
    const appType = staticPreset?.appType ?? (options.spa ? 'spa' : 'static');
    log.error(
      [
        `deploy: --backend cloudflare does not yet support ${appType} (static-asset) apps.`,
        'The Cloudflare backend v1 deploys full Void apps (worker-bearing) on the Cloudflare',
        'Workers target. Deploy this app with `void deploy` (the managed platform), or host',
        'the built assets on Cloudflare Pages / any static host.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 1d. Positive full-Void assertion — the app must actually be worker-bearing. Mirrors the
  // managed dispatch's `runFullDeploy` branch (a `null` preset with no framework) and rejects
  // a bare project with no backend files (no routes/pages/middleware/crons/queues/SSR entry)
  // that `detectPreset` also returns `null` for.
  if (!hasBackendFiles(root)) {
    log.error(
      [
        'deploy: --backend cloudflare found no Void backend to deploy.',
        'A full Void app has at least one of: routes/, pages/, middleware, crons/, queues/,',
        'or an SSR entry. Add your server code, or use `void deploy` for a static site.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 1e. voidPlugin structural rejects — mirror the deterministic throws voidPlugin itself
  // hits during `vite build`, reusing voidPlugin's OWN validators (no re-derivation), so an
  // app that cannot build never reaches account mutation first: a sourceDir convention
  // duplicated at the root (`assertNoRootSourceConventionConflicts`), a broken SSR entry
  // (`validateSsrEntry`), and a malformed cron file (`scanJobsSync`). (sandbox / void/live /
  // AI / remote / websocket are wired fine by the full-Void self-host build — no guard.)
  const paths = resolveProjectPaths(root, voidConfig);
  try {
    assertNoRootSourceConventionConflicts(paths);
    validateSsrEntry(root, paths);
    scanJobsSync(root, paths.cronsDir);
  } catch (err) {
    log.error(`deploy: ${getErrorMessage(err)}`);
    return exit(1);
  }

  // 1f. WebSocket / Durable Object guard — FAIL CLOSED before any account op. For a `.ws.ts`
  // route, the self-host `vite build` emits a `durable_objects` binding plus a DO migration
  // block keyed `new_classes` (index.ts `mergeBindings`, via the SAME `scanWebSocketRoutesSync`
  // scan; also cli/wrangler.ts for --provision) — i.e. a KEY-VALUE-backed Durable Object
  // namespace. As of Cloudflare's 2026-07-09 change, a fresh account (every Workers Free
  // account, and any account with no pre-existing KV-backed namespace) REJECTS a `new_classes`
  // migration at `wrangler deploy` ("create a namespace using a new_sqlite_classes migration
  // instead"). So a websocket app deployed to a fresh own-account hard-fails after the build.
  // Emitting `new_sqlite_classes` is a build-side follow-up; until then reject those apps.
  // (sandbox / void/live DOs already emit `new_sqlite_classes` — they stay supported.)
  if (scanWebSocketRoutesSync(root, paths).length > 0) {
    log.error(
      [
        'deploy: --backend cloudflare does not yet support WebSocket / Durable Object routes.',
        'A `.ws.ts` route makes the build emit a key-value-backed Durable Object namespace',
        '(a `new_classes` migration), which a fresh Cloudflare account (and every Workers Free',
        'account) refuses to create. Deploy this app with `void deploy` (the managed platform).',
        'SQLite-backed WebSocket support for this backend is a follow-up.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 2. Desired resource set — computed ONCE from SOURCE, pre-build (fail-fast),
  // shared by the provision and drift paths. `authEnabled` / `migrationsDir` /
  // `dialect` drive the auth + migration gates below. The checked-in migrations are
  // deliberately NOT read here: the auth + migration gates re-collect them AFTER the
  // build (see step 8), because `vite build` runs arbitrary project plugins that could
  // add/rewrite migration SQL, and the remote apply reads the live post-build files.
  const configPath = discoverRootWranglerConfig(root);
  const { desired, reasons, authEnabled, dialect, migrationsDir } =
    await computeDesiredCloudflareResources(root, voidConfig, configPath);

  // 2a. Postgres + auth guard — reject before any account op. This backend applies only
  // checked-in `db/migrations/*.sql` to REMOTE D1 (SQLite); a Postgres/Hyperdrive app runs
  // no D1 migrate step here, so it can neither create NOR verify the Better Auth tables. v1
  // supports Void-managed auth on D1/SQLite only. (A pg app WITHOUT auth is still supported.)
  if (authEnabled && dialect === 'postgresql') {
    log.error(
      [
        'deploy: --backend cloudflare does not yet support Void-managed auth on a PostgreSQL app.',
        'This backend verifies + applies auth tables through remote D1 (SQLite) migrations',
        'only; it cannot provision or verify the Better Auth schema on Postgres/Hyperdrive.',
        'Deploy this app with `void deploy` (the managed platform), or switch the app to D1.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 2c. Custom migrations_pattern guard — FAIL CLOSED before any account op. v1 supports ONLY
  // Void's default migration convention: `db/migrations/*.sql` with wrangler's default
  // `migrations_pattern` (unset). An explicit `migrations_pattern` makes wrangler enumerate its
  // remote-apply set through Minimatch over a custom glob, which can diverge from Void's
  // `collectMigrations` (flat dir, `seed.sql` excluded) — so it would apply an unverifiable set
  // to remote D1. Rejecting a custom pattern removes that divergence entirely; the default
  // convention still gets ORDER-parity checked at 6b. (Only the DEPLOYED D1 entry matters.)
  if (desired.d1) {
    // Reject on PRESENCE (any defined value, incl. `""`) — a present-but-empty pattern is
    // still non-default to wrangler, and readStoredResourceName can't tell absent from empty.
    const migrationsPattern = readBindingFieldPresence(
      parseRootWranglerConfig(configPath),
      'd1_databases',
      desired.d1.binding,
      'migrations_pattern',
    );
    if (migrationsPattern.present) {
      log.error(
        [
          `deploy: --backend cloudflare does not support a custom migrations_pattern (${JSON.stringify(migrationsPattern.value)}).`,
          'v1 deploys only the default Void migration convention: db/migrations/*.sql with',
          "wrangler's default pattern (leave `migrations_pattern` unset). A custom glob would",
          'apply a set to remote D1 that Void cannot verify against its own db/migrations.',
          `Remove "migrations_pattern" from the ${desired.d1.binding} D1 binding, then rerun.`,
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // (The auth-migration guard runs at 3d below, AFTER the transport + account pin, so it can
  // derive the Better Auth schema in an isolated subprocess under the build's EFFECTIVE mode +
  // the SAME scrubbed env the build uses — still BEFORE whoami / provision / build / deploy.)

  // 3. Preflight — pin ONE transport, pin the account, confirm wrangler auth.
  const rootConfig = parseRootWranglerConfig(configPath);

  // 3a. Resolve + pin the ONE transport for the WHOLE deploy (build + whoami + migrate +
  // deploy), reusing the provisioner's resolver + dotenv fence. Fail closed on any
  // ambient/dotenv redirect (endpoint, named env, worker-name override, alternate
  // build config) BEFORE any wrangler call — so every child shares one account + API base.
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (err) {
    log.error(`deploy: ${getErrorMessage(err)}`);
    return exit(1);
  }

  // 3b. Pin the account (static check — no network) BEFORE spawning wrangler.
  const accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    log.error(
      [
        'deploy: no Cloudflare account is pinned.',
        'Set `account_id` in your root wrangler.jsonc, or export CLOUDFLARE_ACCOUNT_ID.',
        'A multi-account token makes wrangler prompt (or error in CI) on its own, which',
        'void cannot intercept — so the account must be pinned before deploying.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 3c. Derive the env-INSENSITIVE schema facts — the required-secret NAMES + the keys
  // flagged `.secret()` — AND enforce the v1 envDir/mode narrowing, in an ISOLATED
  // SUBPROCESS under a scrubbed env. Importing the user's env.ts + resolving the Vite
  // config is arbitrary project code, so it must not run in this credential-bearing
  // parent; the child does it safely (it `process.exit`s). The child resolves the config
  // purely to read the effective `{ envDir, mode }` and REJECTS a custom envDir /
  // non-production mode: the build generates the auth artifact under the project ROOT
  // while the worker `vars` come from the build's envDir, so a custom envDir could
  // validate a different table set than the worker ships. The REAL worker vars the gate
  // validates come from the emitted `dist/ssr/wrangler.json` AFTER the build (ground
  // truth), not from here. The child env scrubs the FULL wrangler-auth credential set and
  // pins `NODE_ENV=production` (see {@link buildSchemaProbeEnv}). Run pre-build so a custom
  // envDir / non-production mode / broken env.ts fails fast, before any account op
  // (whoami / provision / build).
  const schemaProbeEnv = buildSchemaProbeEnv(accountId, apiBaseUrl);
  let schemaResult: EnvSchemaProbeResult;
  try {
    schemaResult = await (deps.resolveSchemaFacts ?? resolveEnvSchemaFactsDefault)(
      { root },
      schemaProbeEnv,
    );
  } catch (err) {
    log.error(
      `deploy: could not derive the env schema (required secrets / .secret() flags) — ${getErrorMessage(err)}`,
    );
    return exit(1);
  }
  if (schemaResult.kind === 'reject') {
    log.error(cloudflareEnvDirModeRejectMessage(schemaResult));
    return exit(1);
  }
  if (schemaResult.kind === 'schema-error') {
    log.error(`deploy: ${selfHostSchemaFailureMessage(schemaResult.reason)}`);
    return exit(1);
  }
  const schemaFacts: SelfHostSchemaFacts = schemaResult.facts;

  // 3e. Confirm wrangler auth. `whoami` gets the SAME `-c`/`--env=`/pinned-transport
  // context as migrate/deploy, so it authenticates against the exact endpoint they use.
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  const whoami = await Promise.resolve(
    runWrangler(['whoami', '--json', '-c', configPath, '--env='], { capture: true }),
  );
  if (!isCleanWranglerExit(whoami)) {
    log.error(
      [
        'deploy: not authenticated with Cloudflare.',
        'Run `wrangler login`, or set CLOUDFLARE_API_TOKEN (a token with',
        'Workers Scripts:Edit + read on your bound resources; --provision also needs',
        'per-product *:Edit for D1/KV/R2/Queues/Hyperdrive). Then rerun.',
      ].join('\n'),
    );
    return exit(1);
  }

  // CI gate for --provision: fail closed in non-interactive shells unless the
  // committed config already covers every desired resource (a provable no-op) —
  // CI cannot commit back the ids a create would mint, so a re-run would dup.
  const isCI = deps.isCI ?? (!process.stdin.isTTY || getTokenSource() === 'ci');
  if (options.provision && isCI) {
    const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
    // Queues are name-bearing (no id in the committed config), so the id-drift check
    // CANNOT prove a desired queue is already created — and `provisionCloudflareResources`
    // would run `wrangler queues create` for it, mutating the account. That breaks the
    // "CI --provision is a provable no-op" contract, so fail closed on ANY desired queue.
    if (missing.length > 0 || desired.queues.length > 0) {
      const lines = ['deploy: --provision is disabled in CI / non-interactive shells.'];
      if (missing.length > 0) {
        lines.push('', 'These id-bearing resources are not yet in your committed wrangler.jsonc:');
        for (const entry of missing) {
          const reason = reasons.get(entry.binding);
          lines.push(
            `  • ${entry.binding} (${CLOUDFLARE_RESOURCE_LABELS[entry.kind]})${reason ? ` — ${reason}` : ''}`,
          );
        }
      }
      if (desired.queues.length > 0) {
        lines.push(
          '',
          'These queues cannot be proven already created (queues carry no id in the config):',
        );
        for (const name of desired.queues) {
          lines.push(`  • ${name} (queue)`);
        }
      }
      lines.push(
        '',
        'Provision them locally (`void deploy --backend cloudflare --provision`), commit the',
        'updated wrangler.jsonc, then let CI run `void deploy --backend cloudflare`.',
      );
      log.error(lines.join('\n'));
      return exit(1);
    }
  }

  // 4. Provision (--provision) OR drift-check (no --provision).
  if (options.provision) {
    const provision = deps.provision ?? provisionModule.provisionCloudflareResources;
    let result;
    try {
      result = await provision(root, configPath, desired, {
        accountId,
        log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
      });
      cliLog.info('cloudflare_provisioned', {
        resources: result.resources.map((r) => `${r.kind}:${r.action}`),
      });
    } catch (err) {
      log.error(`deploy: provisioning failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
    // A DESIRED resource the provisioner could not satisfy is FATAL, not success.
    // Hyperdrive returns action "skipped" when there is no connection source and
    // nothing adoptable — deploying past that would ship a worker with no HYPERDRIVE
    // binding that fails on its first DB request. Fail closed with guidance.
    const skipped = result.resources.filter((r) => r.action === 'skipped');
    if (skipped.length > 0) {
      log.error(
        [
          'deploy: these required resources were skipped during provisioning and are NOT available:',
          ...skipped.map((r) => {
            const label =
              CLOUDFLARE_RESOURCE_LABELS[r.kind as ProvisionDriftEntry['kind']] ?? r.kind;
            return `  • ${r.binding ?? r.name} (${label})${r.reason ? ` — ${r.reason}` : ''}`;
          }),
          'Resolve the connection source (e.g. set DATABASE_URL for Hyperdrive, or adopt an',
          'existing config), then rerun. Nothing was built or deployed.',
        ].join('\n'),
      );
      return exit(1);
    }
    // Re-run the id-drift predicate AFTER provisioning: any desired id-bearing
    // resource the provisioner did not write a real id for still drifts and must
    // block the build/deploy (the desired set is the single source of truth).
    const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
    if (missing.length > 0) {
      log.error(
        formatCloudflareDriftMessage(
          missing,
          reasons,
          'deploy: provisioning did not satisfy every required resource:',
          'Rerun `void deploy --backend cloudflare --provision`, or provision the listed resources manually.',
        ),
      );
      return exit(1);
    }
  } else {
    const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
    if (missing.length > 0) {
      log.error(
        formatCloudflareDriftMessage(
          missing,
          reasons,
          'Deploy blocked — resources not yet provisioned in your Cloudflare account:',
          'Run:  void deploy --backend cloudflare --provision',
        ),
      );
      return exit(1);
    }
  }

  // 5. Reconcile the worker `name` AND the pinned `account_id` into the root config
  // BEFORE the build. `name` is only-when-absent (never clobber the user's); the build
  // defaults a name into dist/ssr/wrangler.json, but `wrangler secret list -c <root>`
  // (the secrets gate) resolves the worker from the ROOT config's `name`, so pinning it
  // makes the gate and deploy agree. `account_id` is always overwritten with the
  // reconciled account: the CF Vite plugin copies `account_id` ONLY from the root config
  // file (never from CLOUDFLARE_ACCOUNT_ID) into dist/ssr/wrangler.json, so an env-only
  // pin would otherwise emit an artifact with NO `account_id` and the identity check
  // below could never confirm the pin. Persisting it makes the documented env-only pin
  // deploy the verified account.
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  writeProvisionedWranglerConfig(root, { name: workerName, accountId }, { configPath });

  // (The LOCAL migration gates run POST-build at step 8d, immediately before the remote
  // apply — not here — so they validate the exact files on disk AFTER the build. See step 8d.)

  // 7. Build with the pinned deploy transport — WITHOUT VOID_DEPLOY_PROJECT_ID — so
  // self-host ISR emits and the CF plugin merges the wrangler.jsonc real ids into
  // dist/ssr/wrangler.json. `deployChildEnv` scrubs CLOUDFLARE_ENV +
  // CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (and pins one account + API base), so the CF
  // plugin generates the pinned TOP-LEVEL config from the CANONICAL root wrangler config,
  // not a named-env / alternate-config one whose account/name/bindings could differ.
  //
  // The build runs BEFORE the secret / auth gates: the redesign validates the REAL artifact
  // the build emits (`dist/ssr/wrangler.json` `vars` + the generated auth schema) rather than
  // predicting it, so a missing secret / bad auth schema is caught AFTER the build — the
  // accepted trade-off for reading ground truth. No REMOTE mutation has happened yet (provision
  // ran earlier, but the remote D1 apply + deploy are still ahead), so a failed gate below
  // never leaves a half-migrated / half-deployed account.
  //
  // DELETE the CF plugin's deploy pointer (`.wrangler/deploy/config.json`) FIRST. The
  // plugin OVERWRITES it (never deletes) on each build, but ONLY when the CF Vite plugin
  // participates — a build that emits no worker artifact leaves a STALE pointer from a
  // previous run in place, and a bare `wrangler deploy` would follow it to an old
  // `dist/ssr/wrangler.json`. Removing it now means the reads below (which require the
  // pointer to exist) can only pass on a pointer THIS build re-created.
  removeDeployPointer(root);
  const buildChildEnv = deployChildEnv(accountId, apiBaseUrl);
  delete buildChildEnv.VOID_DEPLOY_PROJECT_ID;
  // Pin NODE_ENV=production for the build too, so the build and the env-schema probes evaluate
  // env.ts under the SAME environment. `vite build` only DEFAULTS NODE_ENV to production when it
  // is unset (`if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv`), so an ambient
  // NODE_ENV=development would otherwise build a development schema while the probes (pinned
  // production) derive a production one — the exact divergence the probe pin exists to close.
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  requireProvisionModule().deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
  buildChildEnv.NODE_ENV = 'production';
  const runBuild =
    deps.runBuild ??
    ((env: NodeJS.ProcessEnv) => {
      execSync(resolveProjectCommand(root, 'vite build'), { cwd: root, stdio: 'inherit', env });
    });
  try {
    runBuild(buildChildEnv);
  } catch (err) {
    log.error(`deploy: build failed — ${getErrorMessage(err)}`);
    return exit(getExitCode(err));
  }

  // Re-collect the checked-in migrations from disk AFTER the build. `vite build` runs
  // arbitrary project plugins that could add or rewrite `db/migrations` SQL (or the
  // `migrations_dir` presence), and step 9's `wrangler d1 migrations apply` reads the
  // LIVE post-build files — so every migration that can reach remote D1 must be validated
  // against exactly what is on disk now, not a pre-build snapshot. This one set feeds both
  // the auth-schema check (8c) and the local migration gates (8d).
  const migrations = collectMigrations(migrationsDir);

  // 8. Post-build GROUND-TRUTH gates — validate the REAL artifact the build emitted, not a
  // facsimile. Read the actual `vars` the build baked into `dist/ssr/wrangler.json`, then
  // WARN (plaintext secret-looking vars) + GATE (required secrets, incl. INVALID values) +
  // auth-schema check + local migration gates, all against that ground truth. The only
  // project code that runs does so in the isolated `validate-emitted` probe (8b).
  const emitted = (deps.readEmittedWorkerVars ?? readEmittedWorkerVarsDefault)(root);
  if (!emitted.ok) {
    log.error(
      [
        'deploy: could not read the worker vars the build emitted — refusing to validate secrets.',
        `  ${emitted.reason}`,
        'The build must emit dist/ssr/wrangler.json for this backend. Rerun the build, or deploy',
        'this app with `void deploy` (the managed platform).',
      ].join('\n'),
    );
    return exit(1);
  }
  const emittedVars = emitted.vars;

  // 8a. Plaintext-var warnings — classify the secret-looking keys among the REAL emitted vars
  // (`.secret()`-flagged from the schema facts, OR the shared name heuristic). Ground truth —
  // no `loadEnv`, no facsimile.
  const warnings = collectPlaintextVarWarningsFromVars(
    emittedVars,
    schemaFacts.hasSchema ? schemaFacts.secretKeys : [],
  );
  if (warnings.secretKeys.length > 0) {
    log.warn(
      [
        'deploy: these worker vars ship as PLAINTEXT in the deployed config:',
        ...warnings.secretKeys.map(
          (k) => `  • ${k.key}${k.reason === 'schema-secret' ? ' (env.ts .secret())' : ''}`,
        ),
        'Move real secrets to `wrangler secret put <NAME>` so they are not baked into wrangler.json.',
      ].join('\n'),
    );
  }

  // 8b. Required-secret gate — build the values-free context from the REAL emitted vars + the
  // env-insensitive required-key names (pure parent work, no project code): a required key
  // shipped EMPTY (`K=""`) SHADOWS a same-named remote secret → fail closed always; a required
  // key ABSENT from the emitted vars is discharged only by `wrangler secret list`.
  const envContext = deriveSelfHostEnvContextFromVars(emittedVars, schemaFacts);
  // Then VALUE-validate the REAL emitted vars against the schema's validators in the isolated
  // `validate-emitted` probe (project code, off this credentialed parent) and fold the FAILING
  // key NAMES into the context, so a required var shipped with a MALFORMED value (e.g. a
  // non-number `PORT`, a bad JSON object) fails closed HERE — before any remote mutation —
  // rather than only at worker boot. Values-free: only key names cross the process boundary.
  if (schemaFacts.hasSchema) {
    let validateResult: EnvSchemaValidateResult;
    try {
      validateResult = await (deps.validateEmittedVars ?? validateEmittedVarsDefault)(
        { root },
        buildSchemaProbeEnv(accountId, apiBaseUrl),
      );
    } catch (err) {
      log.error(
        `deploy: could not validate the emitted worker vars against the env schema — ${getErrorMessage(err)}`,
      );
      return exit(1);
    }
    if (validateResult.kind === 'schema-error') {
      log.error(`deploy: ${selfHostSchemaFailureMessage(validateResult.reason)}`);
      return exit(1);
    }
    envContext.invalidKeys = validateResult.invalidKeys;
  }
  // DISCHARGE the context. Reuses the same `dischargeSelfHostEnvContext` the unit tests
  // exercise — now fed the ground-truth vars + the real invalid-value set.
  try {
    await (deps.dischargeSelfHostEnv ?? dischargeSelfHostEnvContext)(envContext, {
      root,
      configPath,
      accountId,
    });
  } catch (err) {
    if (
      err instanceof SelfHostFirstDeployError ||
      err instanceof SelfHostSecretListError ||
      err instanceof SelfHostEnvValidationError ||
      err instanceof SelfHostSchemaError
    ) {
      log.error(err.message);
      return exit(1);
    }
    throw err;
  }

  // 8c. Auth-schema check — the managed platform creates Void-managed Better Auth tables at
  // RUNTIME (POST /__void/migrate/auth) after dispatch; this self-host backend never calls it,
  // it only applies checked-in `db/migrations/*.sql`. So verify the checked-in migrations
  // PRODUCE the required Better Auth schema (tables + columns, incl. configured renames + plugin
  // tables) by reading the schema the BUILD generated (`.void/better-auth-schema.ts` — ground
  // truth) and applying the migrations to in-memory SQLite. `dialect` is guaranteed `'sqlite'`
  // here (pg+auth was rejected at 2a).
  if (authEnabled) {
    try {
      await (deps.validateAuthMigrations ?? validateAuthMigrationSchema)(root, migrations);
    } catch (err) {
      log.error(
        [
          'deploy: --backend cloudflare cannot verify the Void-managed Better Auth schema.',
          'The managed platform creates these tables at runtime (POST /__void/migrate/auth)',
          'after deploy; this self-host backend only applies checked-in db/migrations/*.sql, so',
          'they must already produce the Better Auth schema:',
          `  ${getErrorMessage(err)}`,
          'Generate a migration that creates the Better Auth tables (define them in',
          '`db/schema.ts`, run `void db generate`, commit), then rerun — or deploy this app',
          'with `void deploy` (the managed platform).',
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // 8d. Local migration gates (D1/SQLite apps only; pg/Hyperdrive skip) — run POST-build,
  // immediately before the remote apply, against the RE-COLLECTED post-build migrations. Moving
  // them here (from pre-build) closes the window where a build plugin could add/rewrite migration
  // SQL that step 9 would then apply to remote D1 ungated: `wrangler d1 migrations apply` reads
  // the live post-build files, and these gates now validate exactly that set. Nothing between the
  // build and here mutates remote state, so a failed gate never leaves a half-migrated account.
  let d1MigrateToken: string | undefined;
  if (desired.d1) {
    // 8d-i. Run the SAME gates the managed deploy runs — schema drift, journal coherence,
    // destructive-op-without-pragma — for EVERY D1 app REGARDLESS of migration count. A
    // `db/schema.ts` with no generated migration is drift the old count-gated check silently
    // skipped (shipping a schemaless remote DB); wrangler also auto-applies destructive SQL in CI
    // (its confirmation defaults to "yes" non-interactively). `validateMigrations` self-guards on
    // an empty set.
    try {
      (deps.assertMigrationsDeployable ?? assertRemoteMigrationsDeployable)(
        root,
        dialect,
        migrationsDir,
        migrations,
      );
    } catch (err) {
      log.error(getErrorMessage(err));
      return exit(1);
    }

    // Resolve + validate the migrate target ONLY when there ARE checked-in migrations: a D1
    // desired purely from DB-use or auth can have no `db/migrations`, and wrangler 4.107
    // HARD-FAILS `d1 migrations apply` on a missing/empty folder (it never no-ops).
    if (migrations.length > 0) {
      // `migrations_dir` must be present in the config: wrangler defaults a missing value to
      // `./migrations` (relative to the config) and would apply an unrelated folder.
      const migrateConfig = parseRootWranglerConfig(configPath);
      const d1MigrationsDir = readStoredResourceName(
        migrateConfig,
        'd1_databases',
        desired.d1.binding,
        'migrations_dir',
      );
      if (!d1MigrationsDir) {
        log.error(
          [
            `deploy: D1 binding ${desired.d1.binding} has no "migrations_dir" in ${configPath}.`,
            'Refusing to run `wrangler d1 migrations apply` — wrangler would default to',
            '`./migrations` (relative to the config) and apply an unrelated folder to your',
            'remote database, or error. Run `void deploy --backend cloudflare --provision`',
            'once to set `migrations_dir` (it writes `./db/migrations`), or add it yourself.',
          ].join('\n'),
        );
        return exit(1);
      }
      // wrangler 4.107 resolves the migrate target by FIRST-matching the passed token
      // against `database_name` OR `binding` (getDatabaseInfoFromConfig, src/d1/utils.ts)
      // and reads THAT entry's `migrations_dir`. The gate validated the entry matched by
      // BINDING, so migrate by a token that resolves to exactly that entry — fail closed
      // when an earlier alias entry would shadow it (else wrangler could migrate the wrong
      // DB / an unrelated folder though the gate passed).
      const migrateTarget = resolveD1MigrateTarget(migrateConfig, desired.d1.binding);
      if (!migrateTarget.ok) {
        log.error(
          [
            `deploy: cannot safely run D1 migrations for binding ${desired.d1.binding} — ${migrateTarget.reason}`,
            'wrangler resolves `d1 migrations apply <name>` by first-matching the name against',
            "each entry's database_name OR binding, so an ambiguous token could migrate a",
            'different database than the one validated. Give each D1 database a unique',
            'database_name (and binding), then rerun.',
          ].join('\n'),
        );
        return exit(1);
      }

      // 8d-ii. The EXACT files wrangler will apply (its own `migrations_dir` + `migrations_pattern`
      // resolution) must EQUAL the gated source set by normalized name AND content. Otherwise
      // a stray/extra `.sql` (e.g. `seed.sql`, which the gate's `collectMigrations` skips but
      // wrangler's `*.sql` glob matches), a differing dir, or a divergent file would be applied
      // to REMOTE D1 unvalidated. The gate above only checked `migrations`; this makes the
      // applied set == the validated set.
      const applyCheck = await (deps.checkMigrationApplySet ?? checkWranglerMigrationApplySet)(
        configPath,
        migrateConfig,
        desired.d1.binding,
        d1MigrationsDir,
        migrations,
      );
      if (!applyCheck.ok) {
        log.error(applyCheck.reason);
        return exit(1);
      }
      d1MigrateToken = migrateTarget.token;
    }
  }

  // 9. Apply pending migrations to remote D1 — AFTER all local + ground-truth gates pass, so a
  // failed gate never mutates remote D1. Uses the token resolved + validated at step 8d, and the
  // pinned root config (`-c`), which targets the account already verified by provision/drift.
  if (d1MigrateToken) {
    // 9a. Apply.
    const migrate = await Promise.resolve(
      runWrangler(
        ['d1', 'migrations', 'apply', d1MigrateToken, '--remote', '-c', configPath, '--env='],
        { capture: false },
      ),
    );
    if (!isCleanWranglerExit(migrate)) {
      log.error(
        `deploy: remote D1 migrations failed for "${d1MigrateToken}" (exit ${String(migrate.status)}). ` +
          'Fix the migration and rerun. Note: D1 always enforces foreign_keys=ON — a Drizzle ' +
          'table-rebuild using PRAGMA foreign_keys=OFF must use PRAGMA defer_foreign_keys instead.',
      );
      return exit(1);
    }

    // 9b. Verify NO migrations remain pending on remote. `d1 migrations apply` EXITS 0 when
    // its confirmation is DECLINED (interactive) — a no-op that reads as success — and prints
    // no machine-readable applied set. `d1 migrations list --remote` queries the remote
    // `d1_migrations` table and prints "Migrations to be applied:" when any remain, else the
    // affirmative "No migrations to apply!". Both emit at wrangler's `log` level, which the
    // child env PINS (`WRANGLER_LOG=log`), so an ambient reduced level can never suppress
    // them. Reject on the pending marker, REQUIRE the affirmative sentinel, and reject any
    // empty/unrecognized output rather than trust an absent marker.
    const migrateList = await Promise.resolve(
      runWrangler(
        ['d1', 'migrations', 'list', d1MigrateToken, '--remote', '-c', configPath, '--env='],
        { capture: true },
      ),
    );
    if (!isCleanWranglerExit(migrateList)) {
      log.error(
        `deploy: could not verify the remote migration state for "${d1MigrateToken}" ` +
          `(\`d1 migrations list\` exit ${String(migrateList.status)}). Refusing to deploy against ` +
          'an unverified schema — rerun once wrangler can reach your account.',
      );
      return exit(1);
    }
    if (migrateList.stdout.includes('Migrations to be applied:')) {
      log.error(
        [
          `deploy: remote D1 still has UNAPPLIED migrations for "${d1MigrateToken}" after apply.`,
          '`wrangler d1 migrations apply` exits 0 even when its confirmation is declined, so',
          'the schema may be un-migrated while the code that needs it is about to deploy.',
          'Re-run and confirm the migration (or apply it non-interactively), then rerun.',
        ].join('\n'),
      );
      return exit(1);
    }
    if (!migrateList.stdout.includes('No migrations to apply!')) {
      log.error(
        [
          `deploy: could not confirm the remote migration state for "${d1MigrateToken}".`,
          '`wrangler d1 migrations list` printed neither the "no migrations to apply" nor the',
          '"migrations to be applied" marker (WRANGLER_LOG is pinned so they are never',
          'suppressed) — refusing to deploy against an unverified schema. Rerun once wrangler',
          'can reach your account.',
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // 10. Verify the generated deploy config targets the pinned account + expected worker
  // AND the exact provisioned binding IDENTITIES BEFORE uploading. A `CLOUDFLARE_ENV` /
  // `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` the CF plugin loaded could have baked a
  // different account/name — or the SAME account/name with a flattened, DIFFERENT binding
  // set — into dist/ssr/wrangler.json; passing `desired` + the root config lets the check
  // reject a divergent binding set, not only an account/name mismatch.
  const verification = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(root, {
    accountId,
    workerName,
    rootConfigPath: configPath,
    desired,
  });
  if (!verification.ok) {
    log.error(
      [
        'deploy: the generated deploy config does not match the pinned target — refusing to deploy.',
        verification.reason,
        'This typically means CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (in the',
        'environment or a production `.env`) selected a different named environment or config',
        'at build time. This backend always deploys the canonical top-level config — remove',
        'them and rebuild.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return exit(1);
  }

  // 11. Deploy — bare `wrangler deploy` follows .wrangler/deploy/config.json →
  // dist/ssr/wrangler.json (which carries the real ids + pinned account). `--env=` pins
  // the top-level env so an ambient CLOUDFLARE_ENV cannot reselect a named one.
  // `--experimental-provision=false` / `--experimental-auto-create=false` disable
  // wrangler 4.107's OWN resource provisioning (both default true, deployCommand +
  // globalFlags, wrangler-dist/cli.js), so ONLY `provisionCloudflareResources` may create
  // resources — a bare deploy can never auto-create a missing binding (e.g. an R2 bucket
  // absent remotely but passing the local drift predicate), even in CI.
  // `--autoconfig=false` disables wrangler 4.107's framework detection + auto-config
  // (`autoconfig` defaults true, deployCommand cli.js:292315). Without it, and because we
  // pass no `-c`, a detected framework marker (e.g. OpenNext) makes wrangler DELEGATE the
  // deploy to another tool (`maybeDelegateToOpenNextDeployCommand`, cli.js:292343) — which
  // would upload something OTHER than the artifact Void just built and verified. Forcing it
  // off guarantees wrangler uploads exactly the verified `dist/ssr/wrangler.json`.
  const deployResult = await Promise.resolve(
    runWrangler(
      [
        'deploy',
        '--env=',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: false },
    ),
  );
  if (!isCleanWranglerExit(deployResult)) {
    log.error(`deploy: \`wrangler deploy\` failed (exit ${String(deployResult.status)}).`);
    return exit(1);
  }
  cliLog.info('cloudflare_deploy_end', { ok: true, worker: workerName });
  log.success(`Deployed "${workerName}" to your Cloudflare account.`);
}

/**
 * Discover the root wrangler config path the same way the build / bindings
 * writer do (wrangler.jsonc first, then wrangler.json). Falls back to the
 * default wrangler.jsonc path when none exists yet — the provisioner creates it.
 */
function discoverRootWranglerConfig(root: string): string {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const candidate = join(root, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return join(root, 'wrangler.jsonc');
}

async function runDeployInner(
  root: string,
  options: RunDeployOptions | undefined,
  cliLog: CliLogger,
): Promise<void> {
  // Fork to the self-hosted Cloudflare backend BEFORE any managed-platform work
  // (auth token, PlatformClient, project resolution, config read, branch
  // selection). Everything below stays byte-for-byte the managed `void` path.
  if (options?.backend === 'cloudflare') {
    return runCloudflareDeploy(root, options, cliLog);
  }

  let reauthenticated = false;
  while (true) {
    try {
      // 1. Auth — resolve the deploy token by precedence:
      //   1. explicit `VOID_TOKEN` env  (deliberate override; wins everywhere)
      //   2. GitHub Actions OIDC exchange  (in Actions, when no explicit token)
      //   3. saved keychain / config file  (local dev)
      //
      // OIDC MUST beat an AMBIENT saved token here. `getToken()` returns the env
      // token AND a keychain/config-file token, so calling it first would let a
      // leftover `void auth login` credential on a self-hosted / reused runner
      // preempt OIDC — silently deploying with a broad, long-lived `aud:'api'`
      // user token (or failing outright if it is stale) instead of the
      // short-lived, project-scoped `aud:'deploy'` token the workflow's
      // `id-token: write` intends. So we read the EXPLICIT env directly (NOT via
      // getToken), then OIDC, then the saved token. This matches the old
      // scaffold, which exported the freshly exchanged token as `VOID_TOKEN`
      // before `void deploy` so the deploy token always won inside Actions.
      let token = process.env.VOID_TOKEN ?? null;
      if (!token && isGithubActionsOidcAvailable()) {
        // Running inside GitHub Actions with no explicit VOID_TOKEN: mint a
        // GitHub OIDC token and exchange it for a short-lived, project-scoped
        // deploy token. The slug must resolve WITHOUT a platform client (there
        // is no token yet): --project flag > VOID_PROJECT env > linked
        // .void/project.json — the same sources the deploy path uses below. A
        // workflow with `id-token: write` intends OIDC, so an unknown slug is a
        // hard error — we do NOT silently fall back to a saved token.
        const slug = getRequestedProjectSlug(options) ?? readProjectConfig(root)?.slug;
        if (!slug) {
          throw new Error(
            'deploy: running in GitHub Actions but the project is unknown — pass --project <slug> or link the project.',
          );
        }
        cliLog.info('github_oidc_exchange_start', { slug });
        token = await exchangeGithubOidcForDeployToken(getApiUrl(root), slug);
        maskGithubActionsSecret(token);
        // Export the minted token so the downstream build/prerender can reach
        // it. Both prerender paths re-read credentials via `getToken()`, which
        // reads `process.env.VOID_TOKEN` first: the in-process path
        // (`collectPrerenderPaths` below) and the spawned `vite build` child
        // (`plugin-prerender`'s closeBundle, which inherits `process.env` via
        // `buildEnv`). A local variable can't reach either, so without this the
        // prerender injects no `__VOID_TOKEN`/`__VOID_PROJECT_ID` and renders
        // against local/empty bindings (AI, remote D1/KV/R2 break). This
        // restores parity with the removed scaffold step that wrote
        // `VOID_TOKEN` to `$GITHUB_ENV`. Guarded by the enclosing `!token`
        // branch, so an explicit `VOID_TOKEN` is never overwritten.
        process.env.VOID_TOKEN = token;
        cliLog.info('github_oidc_exchange_success', { slug });
      }
      // Local dev / non-Actions (or Actions without id-token permission): fall
      // back to the saved keychain/config token. `getToken()` re-checks
      // `VOID_TOKEN` first, which is harmlessly unset on this branch.
      token ??= getToken(root);
      if (!token) {
        log.error('No auth token found. Run `void auth login` first.');
        process.exit(1);
      }

      const client = new PlatformClient(token, { root, cliLog });

      // The CF Access service-token pair is intentionally left in `process.env`
      // so interactive expired-token re-auth (below) can still read it. It is
      // kept OUT of every untrusted build child instead, via `buildEnv()` on the
      // spawn env — see that helper for the full rationale.

      // 2. Resolve target project (CLI flag > env var > linked project file)
      const requestedProjectSlug = getRequestedProjectSlug(options);
      let config: ProjectConfig | null = null;

      if (requestedProjectSlug) {
        const projects = await client.listProjects();
        config = resolveProjectBySlug(projects, requestedProjectSlug);

        if (!config) {
          if (!process.stdin.isTTY) {
            // CI: auto-create when --project is explicitly specified
            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          } else {
            const shouldCreate = await confirm({
              message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
            });
            if (isCancel(shouldCreate) || !shouldCreate) {
              log.info('Deploy cancelled.');
              process.exit(0);
            }

            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          }
        }
      } else {
        config = readProjectConfig(root);
      }

      if (!config && !process.stdin.isTTY) {
        log.error(
          'No project specified. Set `VOID_PROJECT`, pass `--project <slug>`, or commit `.void/project.json`.',
        );
        process.exit(1);
      }

      if (!config) {
        config = await promptDeployProjectConfig(root, client, cliLog);
      }

      cliLog.info('project_resolved', {
        projectId: config.projectId,
        slug: config.slug,
      });

      // 3. Resolve deploy app type: void.json > CLI flags > auto-detection
      const voidConfig = readConfig(root);
      cliLog.info('config_resolved', {
        target: voidConfig.target,
        appType: voidConfig.inference?.appType,
        output: voidConfig.output,
      });

      let preset = resolveStaticDeployPreset(root, voidConfig, {
        dir: options?.dir,
        spa: options?.spa,
      });

      // Check for known framework after static overrides.
      const detected = detectFramework(root);
      if (!preset && detected) {
        cliLog.info('framework_detected', {
          name: detected.name,
          class: detected.class,
        });
        const gitMetadata = collectGitDeployMetadata(
          root,
          options?.skipBuild ? null : getGitCommit(root),
        );
        const fwPreset = FRAMEWORK_PRESETS[detected.name];
        if (detected.class === 'b' || detected.class === 'c') {
          if (!fwPreset) {
            log.error(`No deploy preset found for framework "${detected.name}".`);
            process.exit(1);
          }
          await runFrameworkDeploy(
            root,
            config,
            client,
            detected,
            fwPreset,
            voidConfig,
            options?.skipBuild,
            gitMetadata,
            cliLog,
          );
        } else {
          // Class A: preset is optional (e.g. vinext probes at runtime)
          await runFullDeploy(
            root,
            config,
            client,
            fwPreset,
            options?.skipBuild,
            gitMetadata,
            detected,
            cliLog,
          );
        }
        return;
      }
      if (!preset && !voidConfig.inference?.appType) {
        // No configured app type and no detected framework — detect from project structure.
        preset = detectPreset(root, { spa: options?.spa });
      }
      // appType === "void" or "framework" without a detected framework → full deploy.

      // Detect git commit before build (only when not skipping build)
      const gitMetadata = collectGitDeployMetadata(
        root,
        options?.skipBuild ? null : getGitCommit(root),
      );

      if (preset) {
        preset = {
          ...preset,
          buildCommand: resolveStaticBuildCommand(
            preset,
            voidConfig.inference?.build,
            Boolean(options?.dir),
          ),
        };
        await runStaticDeploy(
          root,
          config,
          client,
          preset,
          options?.skipBuild,
          gitMetadata,
          undefined,
          undefined,
          undefined,
          undefined,
          voidConfig.routing,
          cliLog,
        );
      } else {
        await runFullDeploy(
          root,
          config,
          client,
          undefined,
          options?.skipBuild,
          gitMetadata,
          undefined,
          cliLog,
        );
      }
      return;
    } catch (error) {
      if (isExpiredTokenError(error)) {
        if (getTokenSource() === 'ci') {
          throw new Error(
            '`VOID_TOKEN` is invalid or expired. Generate a new token and try again.',
          );
        }
        if (!process.stdin.isTTY || reauthenticated) {
          throw new Error('Auth token expired. Run `void auth login` and try again.');
        }
        log.warn('Auth token expired. Re-authenticating...');
        await promptForLoginToken(root);
        log.success('Re-authenticated. Retrying deploy...');
        reauthenticated = true;
        continue;
      }
      throw error;
    }
  }
}

export async function promptDeployProjectConfig(
  root: string,
  client: PlatformClient,
  cliLog?: CliLogger,
): Promise<ProjectConfig> {
  const projects = await client.listProjects();
  const action = await promptProjectSetupAction('Set up a Void project for deploy:', {
    includeLink: projects.length > 0,
  });

  if (action === 'create') {
    return promptAndCreateProject(root, client);
  }

  // Project names are only shown after the user opts into linking.
  const result = await promptProjectSelection(projects, 'Select a project to deploy to:', root, {
    confirmExisting: true,
    includeCreate: false,
  });

  if (result.action === 'create') {
    throw new Error('Unexpected project selection result.');
  }
  const config = { projectId: result.project.id, slug: result.project.slug };
  writeProjectConfig(root, config);
  log.step(`Linked to ${pc.blue(config.slug)}`);
  cliLog?.info('project_linked', { projectId: config.projectId, slug: config.slug });
  return config;
}

export function resolveStaticBuildCommand(
  preset: StaticPreset,
  buildOverride?: string,
  hasExplicitDir = false,
): string | null {
  if (hasExplicitDir) {
    return null;
  }
  return buildOverride ?? preset.buildCommand;
}

export function resolveStaticDeployPreset(
  root: string,
  voidConfig: VoidConfig,
  options?: Pick<RunDeployOptions, 'dir' | 'spa'>,
): StaticPreset | null {
  if (options?.dir) {
    return detectPreset(root, { dir: options.dir, spa: options.spa });
  }

  const appType = voidConfig.inference?.appType;
  if (appType === 'static' || appType === 'spa') {
    const outputDir = voidConfig.inference?.outputDir;
    const preset: StaticPreset = {
      buildCommand: null,
      outputDir: outputDir ? resolve(root, outputDir) : join(root, 'dist'),
      appType,
    };

    // Re-detect build command (config stores app type, not command).
    const detectedPreset = detectPreset(root, { spa: options?.spa });
    if (detectedPreset) {
      preset.buildCommand = detectedPreset.buildCommand;
      if (!outputDir) {
        preset.outputDir = detectedPreset.outputDir;
      }
    }
    return preset;
  }

  return null;
}

export type ApplyDeployEventResult =
  | { kind: 'continue' }
  | { kind: 'start'; deploymentId: string }
  | { kind: 'done'; event: DeployDoneEvent }
  | { kind: 'error'; message: string };

/**
 * Apply the visible side effects of a streamed deploy event (spinner
 * message or log warning). Returns a discriminated result so the caller
 * advances its own state (deploymentId capture, final return, error
 * throw). Pure function of (event, s) so the switch stays unit-testable.
 */
export function applyDeployEvent(event: DeployEvent, s: SpinnerResult): ApplyDeployEventResult {
  switch (event.event) {
    case 'start':
      s.message('Deploying...');
      return { kind: 'start', deploymentId: event.deploymentId };
    case 'heartbeat':
      return { kind: 'continue' };
    case 'asset_upload':
      if (event.new > 0) {
        s.message(`Uploading assets (${event.new} new, ${event.cached} cached)`);
      } else {
        s.message(`Uploading assets (${event.total} cached)`);
      }
      return { kind: 'continue' };
    case 'provisioning':
      s.message(`Provisioning ${event.bindings.join(', ')}`);
      return { kind: 'continue' };
    case 'worker_readiness':
      s.message('Waiting for worker to become reachable...');
      return { kind: 'continue' };
    case 'migration_start':
      s.message(`Running ${event.pending} migration${event.pending > 1 ? 's' : ''}...`);
      return { kind: 'continue' };
    case 'migration':
      s.message(`Applied migration: ${event.name} (${event.durationMs}ms)`);
      return { kind: 'continue' };
    case 'worker_upload':
      s.message('Uploading worker...');
      return { kind: 'continue' };
    case 'queue_setup':
      s.message(`Configuring queue consumers: ${event.queues.join(', ')}`);
      return { kind: 'continue' };
    case 'queue_consumer_conflict':
      // log.warn persists above the spinner so the warning survives the
      // next s.message call — the user needs to see this after deploy
      // completes, not just as a transient spinner frame.
      log.warn(
        `Queue consumer conflict on "${event.queue}": owned by "${event.ownerScript}". ` +
          `Messages for this queue will not be delivered to this deployment ` +
          `until the owning script is removed.`,
      );
      return { kind: 'continue' };
    case 'prerender':
      s.message(`Prerendering ${event.pages} pages...`);
      return { kind: 'continue' };
    case 'done':
      if (event.published === false) {
        // Committed-live in the DB but routing KV was not published. The
        // deploy succeeded (do NOT throw / return an error kind) but the
        // project may be unreachable (first deploy) or still serving the
        // previous deploy (later deploy). Degrade the message accordingly.
        s.stop(
          'Deployed, but routing was not published — the project may be unreachable or still serving the previous deploy. Re-run `void deploy` to publish routing.',
        );
      } else {
        s.stop('Deployed!');
      }
      return { kind: 'done', event };
    case 'error':
      s.stop('Deploy failed');
      return { kind: 'error', message: event.message };
  }
  return { kind: 'continue' };
}

/**
 * Apply a streamed `DeployEvent` iterator to the spinner / cliLog and
 * resolve with the terminal `done` event (or throw on terminal error /
 * connection loss).
 */
export async function streamDeployEvents(
  projectId: string,
  events: AsyncGenerator<DeployEvent>,
  s: SpinnerResult,
  cliLog?: CliLogger,
): Promise<StreamDeployResult> {
  const startedAt = Date.now();
  let deploymentId: string | null = null;
  let interrupted = false;
  cliLog?.info('stream_start', { projectId });
  const onSigint = () => {
    interrupted = true;
    s.stop('Deploy interrupted');
    if (deploymentId) {
      log.info(`Deployment: ${deploymentId}`);
    } else {
      log.info('Deployment id was not received before the interrupt.');
    }
    cliLog?.warn('stream_interrupted', { deploymentId });
    // Best-effort flush of the JSONL log before the process exits. The
    // returned promise is intentionally not awaited — `process.exit(130)`
    // would race the awaiter, and the OS flushes the page cache for the
    // line-delimited file regardless.
    cliLog?.close().catch(() => {});
    process.exit(130);
  };

  process.once('SIGINT', onSigint);

  try {
    for await (const event of events) {
      const result = applyDeployEvent(event, s);
      if (result.kind === 'start') {
        deploymentId = result.deploymentId;
        cliLog?.info('stream_deployment_id', { deploymentId });
      } else if (result.kind === 'done') {
        const degraded = result.event.published === false;
        // Degraded = committed-live but routing KV not published. Still a
        // `done` outcome (not an error), but logged distinctly so the
        // degraded result is greppable in the JSONL trace.
        cliLog?.info(degraded ? 'deploy_degraded' : 'deploy_success', {
          deploymentId,
          url: result.event.url,
          assets: result.event.assets,
          workers: result.event.workers,
          durationMs: Date.now() - startedAt,
          degraded,
        });
        return result.event;
      } else if (result.kind === 'error') {
        cliLog?.error('deploy_server_error', undefined, {
          deploymentId,
          message: result.message,
        });
        throw new DeployEventError(
          formatDeployFailureMessage(result.message, deploymentId, cliLog?.path ?? null),
        );
      }
    }
  } catch (err) {
    if (err instanceof DeployEventError) {
      throw err;
    }
    if (interrupted) {
      throw err;
    }
    cliLog?.error('stream_deploy_caught', err, { deploymentId });
    s.stop('Deploy failed');
    throw formatStreamDeployError(err, deploymentId, cliLog?.path ?? null);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  cliLog?.warn('stream_no_terminal_event', { deploymentId });
  s.stop('Deploy failed');
  throw new Error(formatConnectionLostMessage(deploymentId, cliLog?.path ?? null));
}

/**
 * Direct-to-R2 deploy orchestration. Issues presigned PUT URLs for each
 * needed asset, uploads bytes directly to R2, then calls the manifest-only
 * deploy endpoint to finalize.
 *
 * Key invariants:
 *   1. No needed assets → skip presign + R2 PUT phase entirely (saves a
 *      round-trip when every asset was already present from a prior deploy).
 *   2. Asset bytes come exclusively from the in-memory `assetFiles` cache
 *      computed by `collectAndHashAssets` — files are NEVER re-read from
 *      disk during this flow (Codex Finding #2 in design doc 0068 review).
 *   3. R2 PUT failures (4xx, 5xx, network) are surfaced with the asset
 *      path + hash so the user can correlate against the JSONL trace.
 */
async function streamDirectR2Deploy(
  client: PlatformClient,
  projectId: string,
  manifest: DeployManifest,
  assetManifest: Record<string, AssetManifestEntry>,
  assetFiles: Map<string, Buffer>,
  needed: Array<string>,
  gitMetadata: GitDeployMetadata | undefined,
  preflightUsed: boolean,
  workerFiles: Map<string, Buffer> | undefined,
  s: SpinnerResult,
  cliLog?: CliLogger,
): Promise<StreamDeployResult> {
  if (needed.length > 0) {
    // Memory: drop buffers for assets the server already has so peak
    // memory tracks `needed`, not the full bundle. Skipped entries become
    // GC-eligible immediately rather than after `finalizeDeploy` returns.
    // The pre-prune size is captured for the JSONL log only. We materialize
    // the key list before deleting so the iterator isn't disturbed mid-walk.
    const neededPaths = new Set(needed);
    const preBufferCount = assetFiles.size;
    const allPaths = Array.from(assetFiles.keys());
    for (const path of allPaths) {
      if (!neededPaths.has(path)) {
        assetFiles.delete(path);
      }
    }
    if (assetFiles.size !== preBufferCount) {
      cliLog?.info('asset_cache_pruned', {
        before: preBufferCount,
        after: assetFiles.size,
      });
    }

    s.message(`Requesting upload URLs for ${needed.length} asset(s)...`);

    // Dedupe by content hash: identical files (same blake3) get presigned
    // and PUT once. `assetManifest` still lists every path for the
    // per-path serving manifest the platform builds in `finalizeDeploy`;
    // this only collapses the upload phase. Common with prerendered HTML,
    // duplicated images, and framework-emitted twins.
    const seenBlake3 = new Set<string>();
    const uniqueNeeded: Array<string> = [];
    for (const path of needed) {
      const entry = assetManifest[path];
      if (!entry) {
        // Should never fire — `needed` is preflight's projection of
        // assetManifest. Defensive throw makes the cause obvious if a
        // future preflight regression slips through.
        throw new Error(`internal: preflight returned ${path} but assetManifest has no entry`);
      }
      if (seenBlake3.has(entry.blake3)) {
        continue;
      }
      seenBlake3.add(entry.blake3);
      uniqueNeeded.push(path);
    }

    const assetsToUpload = uniqueNeeded.map((path) => {
      const entry = assetManifest[path];
      return {
        blake3: entry.blake3,
        md5: entry.md5,
        size: entry.size,
        contentType: getAssetContentType(path),
      };
    });

    cliLog?.info('presign_request_start', {
      assetCount: assetsToUpload.length,
      dedupedFrom: needed.length,
    });
    const presignStartedAt = Date.now();
    const urls = await client.requestUploadUrls(projectId, assetsToUpload);
    cliLog?.info('presign_request_end', {
      urlsReceived: Object.keys(urls).length,
      durationMs: Date.now() - presignStartedAt,
    });

    // Map unique-by-hash paths → DirectR2PutItem, with the asset bytes
    // pulled from the in-memory cache (no disk reads here).
    const items: Array<DirectR2PutItem> = uniqueNeeded.map((path) => {
      const entry = assetManifest[path];
      const presigned = urls[entry.blake3];
      if (!presigned) {
        throw new Error(
          `Platform did not return an upload URL for ${path} (blake3=${entry.blake3}). ` +
            `This indicates a server-side bug or a stale client.`,
        );
      }
      const body = assetFiles.get(path);
      if (!body) {
        // Defensive — `uniqueNeeded` came from `assetManifest`, which was
        // constructed from `assetFiles`. If this fires, the upstream
        // collection diverged from preflight.
        throw new Error(
          `internal: asset ${path} declared in manifest but missing from buffer cache`,
        );
      }
      return {
        path,
        hash: entry.blake3,
        body,
        url: presigned.url,
        headers: presigned.headers,
      };
    });

    s.message(`Uploading ${items.length} asset(s) to R2...`);
    // Per-PUT cleanup: once R2 acks the upload, drop the buffer from the
    // CLI-side cache so peak memory under the bounded upload pool stays
    // close to `R2_PUT_CONCURRENCY` × asset size, not the full bundle.
    await uploadAssetsToR2(items, cliLog, undefined, (item) => {
      assetFiles.delete(item.path);
    });
  } else {
    cliLog?.info('presign_skipped', { reason: 'no_needed_assets' });
  }

  // Build the JSON-mode payload. Worker bytes go in as base64 — the
  // manifest-only endpoint's design (0068) keeps worker bundles in the
  // body since they are bounded at 32 MiB total.
  const payload: ManifestOnlyDeployPayload = {
    manifest,
    assetManifest,
    source: getTokenSource(),
    commit: gitMetadata?.commit ?? null,
    repositoryUrl: gitMetadata?.repositoryUrl ?? null,
    commitUrl: gitMetadata?.commitUrl ?? null,
    gitRef: gitMetadata?.gitRef ?? null,
    preflight: preflightUsed ? 'true' : null,
  };
  if (workerFiles && workerFiles.size > 0) {
    const encoded: Record<string, string> = {};
    for (const [relPath, buf] of workerFiles) {
      encoded[relPath] = buf.toString('base64');
    }
    payload.workerFiles = encoded;
  }

  s.message('Finalizing deploy...');
  cliLog?.info('finalize_start', {
    workerFileCount: workerFiles?.size ?? 0,
    assetCount: Object.keys(assetManifest).length,
  });
  const finalizeStartedAt = Date.now();

  try {
    return await streamDeployEvents(
      projectId,
      client.finalizeDeploy(projectId, payload),
      s,
      cliLog,
    );
  } finally {
    cliLog?.info('finalize_end', { durationMs: Date.now() - finalizeStartedAt });
  }
}

function formatKnownAssetSummary(result: DeployDoneEvent, skipped: number): string {
  const uploaded = result.assets - skipped;
  return skipped > 0
    ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
    : `${result.assets} static asset(s)`;
}

/**
 * Assemble the Void deploy manifest, deriving the route-aware ISR `pages` table
 * from the page scan. This is the single production seam that forwards
 * `pageScan` → `manifest.pages`; `runFullDeploy` calls it so the wiring is
 * exercised (and regression-guarded) by a unit test.
 *
 * `pages` is a Void pages-mode concept. In framework mode (Class-A frameworks
 * routed through `runFullDeploy`) we must NOT emit it — the framework owns its
 * own routing/ISR — so `isFrameworkMode` suppresses the table. (plan 0077
 * Global Constraint: "`pages` is Void-pages-mode only; leave frameworks alone".)
 */
export function assembleVoidManifest(
  pageScan: PageScanResult | null,
  isFrameworkMode: boolean,
  opts: Parameters<typeof buildVoidManifest>[0],
  revalidateConfig?: number | Record<string, number> | undefined,
): DeployManifest {
  return buildVoidManifest({
    ...opts,
    // Bake each page's BUILD-time ISR TTL (3-state) from its own `export const
    // revalidate` first, then a global-NUMBER `routing.revalidate`. A page under
    // an OBJECT config bakes NO TTL (inherit-eligible) — see `collectPages`.
    pages: isFrameworkMode ? undefined : collectPages(pageScan, revalidateConfig),
    // Ship the RAW per-path OBJECT config alongside so dispatch can resolve those
    // inherit-eligible pages against the ACTUAL request path (honoring per-path
    // `0` opt-outs a dynamic pattern straddles). Object form only: a number
    // config is already baked into every `pages` entry, so it is never consulted.
    pathRevalidate:
      isFrameworkMode || revalidateConfig == null || typeof revalidateConfig !== 'object'
        ? undefined
        : revalidateConfig,
  });
}

export async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  hashedAssetsPrefix?: string,
  headerRules?: Array<HeaderRule>,
  redirectRules?: Array<DevRedirectRule>,
  fallbackRules?: Array<DevRedirectRule>,
  routing?: RoutingConfig,
  cliLog?: CliLogger,
): Promise<void> {
  const typeLabel = preset.appType === 'spa' ? 'Static SPA' : 'Static Site';
  log.info(`${typeLabel} deploy`);
  cliLog?.info('deploy_mode', { mode: 'static', appType: preset.appType });

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step('Building...');
    cliLog?.info('build_start', { command: preset.buildCommand });
    const buildStartedAt = Date.now();
    execSync(preset.buildCommand, { cwd: root, stdio: 'inherit', env: buildEnv() });
    cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
  } else if (skipBuild) {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    process.exit(1);
  }

  if (routing) {
    const merged = mergeRoutingRules({ dir: preset.outputDir, routing });
    warnRedundantForceOn3xx(merged.redundantForceOn3xx);
    lintDuplicateSources(merged.redirectRules, 'redirects/rewrites (pre-asset)');
    lintDuplicateSources(merged.fallbackRules, 'fallbacks (post-asset)');
    lintDestinationSplats(merged.redirectRules, 'redirects/rewrites (pre-asset)');
    lintDestinationSplats(merged.fallbackRules, 'fallbacks (post-asset)');
    headerRules = merged.headerRules;
    redirectRules = merged.redirectRules;
    fallbackRules = merged.fallbackRules;
  }

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` carries the in-memory buffer cache so the upload step
  // (direct-to-R2 or legacy multipart) consumes the same bytes that were
  // hashed — eliminates the chain double-read flagged in design doc 0068.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: preset.outputDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(preset.outputDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', { mode: 'static' });
  const packageStartedAt = Date.now();
  const neededSet = skipped > 0 ? new Set(needed) : null;

  const manifest = buildStaticManifest({
    appType: preset.appType,
    hashedAssetsPrefix: hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
    fallbackRules,
  });
  cliLog?.info('package_end', {
    mode: 'static',
    durationMs: Date.now() - packageStartedAt,
  });
  const result = await streamDirectR2Deploy(
    client,
    config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    neededSet !== null,
    undefined,
    s,
    cliLog,
  );

  const summary = [`${typeLabel} — ${formatKnownAssetSummary(result, skipped)}`];
  note(summary.join('\n'), result.url);

  warnUnpublishedRouting(result);
  outro('Done!');
}

/**
 * Surface a persistent warning when a deploy committed live but its routing
 * KV was not published. Uses `log.warn` (not the spinner) so the warning
 * survives the following `note`/`outro` calls and the user sees it after the
 * deploy summary. The deploy is still committed — this is a warning, not a
 * failure, so the process exit code is unaffected.
 */
export function warnUnpublishedRouting(result: StreamDeployResult): void {
  if (result.published !== false) {
    return;
  }
  log.warn(
    'Routing was not published for this deploy. The project may be unreachable (first deploy) or still serving the previous deploy. Re-run `void deploy` to publish routing.',
  );
}

/**
 * Emit a single aggregated lint warning when a `_redirects` file contains
 * one or more `!` force suffixes on 3xx entries (e.g. `301!`, `302!`).
 * The `!` is a no-op on redirects — we parse them as if the `!` weren't
 * there — but we nudge the user to clean up for clarity. Silenced when
 * `count === 0`.
 */
export function warnRedundantForceOn3xx(count: number): void {
  if (count === 0) {
    return;
  }
  log.warn(
    `Found ${count} redundant "!" on 3xx entries in _redirects (these always force by nature; safe to remove).`,
  );
}

/**
 * Class B/C framework deploy: build with framework CLI, package with preset output paths.
 */
async function runFrameworkDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  detected: DetectedFramework,
  fwPreset: FrameworkPreset,
  voidConfig: VoidConfig,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  cliLog?: CliLogger,
): Promise<void> {
  log.info(`${detected.name} framework deploy`);
  cliLog?.info('deploy_mode', { mode: 'framework', framework: detected.name });

  const dialect = getDatabaseDialect(voidConfig);

  // 1. Build
  const buildCmd = voidConfig.inference?.build ?? formatProjectCommand(root, fwPreset.buildCommand);
  if (!skipBuild) {
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    execSync(voidConfig.inference?.build ?? resolveProjectCommand(root, fwPreset.buildCommand), {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv(),
    });
    cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
  } else {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  // 2. Verify output paths
  const workerDir = join(root, fwPreset.workerDir);
  const assetsDir = join(root, fwPreset.assetsDir);
  const frameworkAssetIgnorePatterns =
    fwPreset.workerDir === fwPreset.assetsDir && fwPreset.workerMain === '_worker.js'
      ? [`/${fwPreset.workerMain}`, '/_routes.json']
      : [];

  // Merge framework-generated `_headers` / `_redirects` + void.json routing rules.
  // Netlify-symmetric phases:
  //   - `_redirects` `200!` + routing.rewrites  → redirectRules (always-fires)
  //   - `_redirects` `200`  + routing.fallbacks → fallbackRules (asset-miss only)
  const { headerRules, redirectRules, fallbackRules, redundantForceOn3xx } = mergeRoutingRules({
    dir: assetsDir,
    routing: voidConfig.routing,
  });
  warnRedundantForceOn3xx(redundantForceOn3xx);

  // Lint each phase independently: duplicates across phases (redirects vs
  // fallbacks) don't shadow each other, only duplicates within a phase do.
  lintDuplicateSources(redirectRules, 'redirects/rewrites (pre-asset)');
  lintDuplicateSources(fallbackRules, 'fallbacks (post-asset)');

  // Warn on destinations containing a literal `*` — only `:name` tokens are
  // substituted at dispatch time, so `*` is almost always a user mistake.
  lintDestinationSplats(redirectRules, 'redirects/rewrites (pre-asset)');
  lintDestinationSplats(fallbackRules, 'fallbacks (post-asset)');

  if (!existsSync(workerDir)) {
    log.error(`deploy: Worker output '${fwPreset.workerDir}' not found. Run '${buildCmd}' first.`);
    process.exit(1);
  }

  // 3. Infer or read bindings
  const inferenceOptions = voidConfig.inference?.bindings
    ? { bindings: voidConfig.inference.bindings }
    : undefined;
  const paths = resolveProjectPaths(root, voidConfig);
  const scanDirs = voidConfig.inference?.scanDirs ?? FRAMEWORK_SCAN_DIRS;
  const bindings = inferProjectBindings(root, { ...inferenceOptions, paths }, scanDirs);
  const authEnabled =
    bindings.needsAuth || findVoidAuthConfig(root, paths) !== null || voidConfig.auth !== undefined;

  if (authEnabled) {
    log.error(
      "deploy: Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }
  if (bindings.needsLive) {
    log.error('deploy: void/live is currently supported in Void apps only.');
    process.exit(1);
  }

  const migrationsDir = paths.migrationsDir;

  assertDeploySchemaDriftFree(root, dialect);

  // 4. Collect migrations (before Hyperdrive check so migrations can gate provisioning)
  const rawMigrations = collectMigrations(migrationsDir);
  let validatedMigrations;
  try {
    assertJournalCoherence(migrationsDir, rawMigrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }
  if (rawMigrations.length > 0) {
    try {
      validatedMigrations = validateMigrations(rawMigrations);
      log.info(`Found ${validatedMigrations.length} migration(s)`);
    } catch (err: unknown) {
      log.error(getErrorMessage(err));
      process.exit(1);
    }
  }

  // Pre-deploy: ensure Hyperdrive is provisioned for PostgreSQL projects
  if (dialect === 'postgresql' && (bindings.needsD1 || rawMigrations.length > 0)) {
    let resources: Array<ResourceSummary> | null = null;
    try {
      resources = await client.getResources(config.projectId);
    } catch {
      // Resources endpoint not available
    }
    if (resources) {
      const hasHyperdrive = resources.some(
        (resource: ResourceSummary) => resource.type === 'hyperdrive',
      );
      if (!hasHyperdrive) {
        const { text: promptText, isCancel: isCancelPrompt } = await import('@clack/prompts');
        const connectionString = await promptText({
          message: 'Your project uses PostgreSQL. Enter your connection string:',
          placeholder: 'postgresql://user:pass@host:5432/dbname',
          validate(value) {
            if (!value?.startsWith('postgres://') && !value?.startsWith('postgresql://')) {
              return 'Must start with "postgres://" or "postgresql://"';
            }
          },
        });
        if (isCancelPrompt(connectionString)) {
          log.info('Deploy cancelled.');
          process.exit(0);
        }
        await client.provisionDatabase(config.projectId, connectionString as string);
        log.success('Hyperdrive provisioned.');
      }
    }
  }

  // 5. Generate wrapper if needed (crons or queues present)
  const rawJobs = scanJobsSync(root, paths.cronsDir);
  const rawQueues = scanQueuesSync(root, paths.queuesDir);
  const originalEntry = join(workerDir, fwPreset.workerMain);

  const wrapperFeatures: WrapperFeatures = {
    auth: null,
    crons: rawJobs,
    queues: rawQueues,
    hasMigrations: validatedMigrations != null && validatedMigrations.length > 0,
    migrationDialect: dialect,
  };

  let actualWorkerDir = workerDir;
  let actualWorkerMain = fwPreset.workerMain;

  // Step 1: Bundle if framework has unbundled bare imports (e.g. SvelteKit)
  if (fwPreset.bundle) {
    log.step('Bundling worker...');
    const bundleResult = await bundleEntry(root, originalEntry);
    actualWorkerDir = bundleResult.outputDir;
    actualWorkerMain = bundleResult.entryFilename;
    log.info('Worker bundled');
  }

  // Step 2: Wrap if internal deploy endpoints are needed (in-place, no re-bundling)
  if (needsWrapper(wrapperFeatures)) {
    log.step('Generating wrapper...');
    await generateDeployWrapperIfNeeded(root, actualWorkerDir, actualWorkerMain, wrapperFeatures);
    log.info('Wrapper generated');
  }

  // 8. Read wrangler compat settings (void.json > wrangler.jsonc > build output)
  // Use the original workerDir (not actualWorkerDir) because bundleEntry() may
  // reassign actualWorkerDir to a temporary output — the plugin-generated
  // wrangler.json with correct compat settings lives in the original build output.
  const wranglerCompat = resolveDeployWranglerCompat(root, voidConfig, workerDir, { dialect });

  // 9. Resolve revalidate + prerender from void.json
  const revalidate = voidConfig.routing?.revalidate;
  const prerender = voidConfig.routing?.prerender;

  // Build manifest-format schedules and queues from raw scans
  const schedules = rawJobs.flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const queues = rawQueues.map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));

  // 10. Load .env vars for production (excludes .local files)
  const envVars = loadDeployEnv(root);

  // 10a. Validate against env.ts schema if present.
  await assertEnvSchemaValid(root, client, config.projectId);

  // 10b. Overlay schema `.default(value)` entries for keys not set in
  //     .env files so the deployed worker sees the same fallback as the
  //     typed `env.X` proxy.
  await applySchemaDefaultsToVars(root, envVars);

  // 11. Package & deploy
  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` is threaded through to the upload step so each asset is
  // read from disk once, end-to-end (Codex Finding #2 in design doc 0068).
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: assetsDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(assetsDir, onProgress, {
    ignorePatterns: frameworkAssetIgnorePatterns,
  });
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', {
    mode: 'framework',
    framework: detected.name,
  });
  const packageStartedAt = Date.now();
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const packageOptions = {
    bindingNames: resolveBindingNames(voidConfig.inference?.bindings),
    workerMain: actualWorkerMain,
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
  };

  const manifest = buildFrameworkManifest({
    frameworkName: detected.name,
    workerMain: actualWorkerMain,
    bindings,
    migrations: validatedMigrations,
    schedules,
    queues,
    revalidate,
    revalidateQueryAllowlist: voidConfig.routing?.revalidateQueryAllowlist,
    prerender,
    assetConfig: { not_found_handling: 'none' },
    vars: envVars,
    packageOptions,
    hashedAssetsPrefix: fwPreset.hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
    fallbackRules,
    dialect,
  });
  const workerFiles = collectWorkerFiles(actualWorkerDir);
  cliLog?.info('package_end', {
    mode: 'framework',
    durationMs: Date.now() - packageStartedAt,
  });

  // Migration SQL bytes ride along inside the worker bundle (compiled in
  // by the framework via `migration-handler.ts`); the deploy body only
  // needs `manifest.migrations.pending` so the platform knows to invoke
  // the worker's `/__void/migrate` endpoint after dispatch.
  const result = await streamDirectR2Deploy(
    client,
    config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    neededSet !== null,
    workerFiles,
    s,
    cliLog,
  );

  const summary = [
    `${result.workers} worker module(s), ${formatKnownAssetSummary(result, skipped)}`,
  ];
  if (result.migrations) {
    summary.push(`${result.migrations} migration(s) applied`);
  }
  if (schedules.length > 0) {
    summary.push(`${schedules.length} cron job(s) scheduled`);
  }
  if (queues.length > 0) {
    summary.push(`${queues.length} queue(s) configured`);
  }
  if (prerender && prerender.length > 0) {
    summary.push(`${prerender.length} page(s) prerendered`);
  }
  if (revalidate) {
    if (typeof revalidate === 'number') {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
  }
  summary.push(`Framework: ${detected.name}`);
  note(summary.join('\n'), result.url);

  // Clean up generated wrapper files
  cleanupWrapper(root);

  warnUnpublishedRouting(result);
  outro('Done!');
}

async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  fwPreset?: FrameworkPreset,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  detected?: DetectedFramework,
  cliLog?: CliLogger,
): Promise<void> {
  cliLog?.info('deploy_mode', {
    mode: 'full',
    framework: detected?.name,
  });

  // 3. Build (child process to avoid Vite API side effects on bundle output)
  if (!skipBuild) {
    const buildCmd = formatProjectCommand(root, 'vite build');
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    try {
      // Pass VOID_DEPLOY_PROJECT_ID so plugin-prerender (running inside this
      // child vite build) can resolve the Void projectId without relying on
      // .void/project.json, which may be stale or absent under `--project <slug>`.
      execSync(resolveProjectCommand(root, 'vite build'), {
        cwd: root,
        stdio: 'inherit',
        env: buildEnv({ VOID_DEPLOY_PROJECT_ID: config.projectId }),
      });
      cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
    } catch (err: unknown) {
      cliLog?.error('build_failed', err, { durationMs: Date.now() - buildStartedAt });
      process.exit(getExitCode(err));
    }
  } else {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  // 4. Resolve build output paths from build artifacts (avoids re-resolving
  // Vite config in the main process — plugins only run once inside the build)
  const frameworkBuildCmd = fwPreset
    ? formatProjectCommand(root, fwPreset.buildCommand)
    : undefined;
  const distDir = resolveDistDir(root, fwPreset, frameworkBuildCmd);

  // Detect non-default assetsDir from Vite client manifest for _headers generation
  let assetsPrefix = 'assets';
  const clientManifestPath = join(distDir, 'client', '.vite', 'manifest.json');
  if (existsSync(clientManifestPath)) {
    const manifest: Record<string, { file?: string }> = JSON.parse(
      readFileSync(clientManifestPath, 'utf-8'),
    );
    for (const entry of Object.values(manifest)) {
      if (entry.file?.includes('/')) {
        const dir = entry.file.slice(0, entry.file.indexOf('/'));
        if (dir !== 'assets') {
          assetsPrefix = dir;
        }
        break;
      }
    }
  }

  // 5. Framework mode (Class A — passed from runDeploy)
  const isFrameworkMode = detected != null;

  // 6. Infer bindings (expanded scan dirs in framework mode, or custom from config)
  const deployConfig = readConfig(root);
  const paths = resolveProjectPaths(root, deployConfig);
  const dialect = getDatabaseDialect(deployConfig);
  const deployScanDirs =
    deployConfig.inference?.scanDirs ?? (isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined);
  const bindings = inferProjectBindings(root, { paths }, deployScanDirs);
  if (isSandboxEnabled(deployConfig)) {
    bindings.needsSandbox = true;
  }
  const authEnabled =
    bindings.needsAuth ||
    findVoidAuthConfig(root, paths) !== null ||
    deployConfig.auth !== undefined;
  const effectiveBindings = authEnabled
    ? { ...bindings, needsAuth: true, needsD1: true }
    : bindings;

  if (isFrameworkMode && authEnabled) {
    log.error(
      "Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }

  if (isFrameworkMode && bindings.needsSandbox) {
    log.error('deploy: Cloudflare Sandboxes are currently supported in Void apps only.');
    process.exit(1);
  }
  if (isFrameworkMode && bindings.needsLive) {
    log.error('deploy: void/live is currently supported in Void apps only.');
    process.exit(1);
  }

  const sandboxConfig = bindings.needsSandbox
    ? resolveSandboxConfig(deployConfig, root)
    : undefined;
  if (bindings.needsSandbox && requiresSandboxPlatformImage(deployConfig)) {
    log.error(
      'deploy: `sandbox.image` points at a local Dockerfile. Add `sandbox.platformImage` with a pushed registry image for `void deploy`, or deploy this sandbox directly with Wrangler.',
    );
    process.exit(1);
  }

  // Merge user/framework `_headers` / `_redirects` in the built client dir with
  // `void.json` routing rules. See the framework branch above for phase splitting.
  const clientDir = join(distDir, 'client');
  const { headerRules, redirectRules, fallbackRules, redundantForceOn3xx } = mergeRoutingRules({
    dir: clientDir,
    routing: deployConfig.routing,
  });
  warnRedundantForceOn3xx(redundantForceOn3xx);

  // Lint each phase independently — same rationale as the framework branch.
  lintDuplicateSources(redirectRules, 'redirects/rewrites (pre-asset)');
  lintDuplicateSources(fallbackRules, 'fallbacks (post-asset)');

  // Warn on destinations containing a literal `*` — splat tokens in
  // destinations aren't substituted (`:splat` is the correct token).
  lintDestinationSplats(redirectRules, 'redirects/rewrites (pre-asset)');
  lintDestinationSplats(fallbackRules, 'fallbacks (post-asset)');

  const migrationsDir = paths.migrationsDir;

  assertDeploySchemaDriftFree(root, dialect);

  // 7. Collect and validate migrations (before Hyperdrive check so migrations can gate provisioning)
  const rawMigrations = collectMigrations(migrationsDir);
  let validatedMigrations;
  try {
    assertJournalCoherence(migrationsDir, rawMigrations);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }
  if (rawMigrations.length > 0) {
    try {
      validatedMigrations = validateMigrations(rawMigrations);
      log.info(`Found ${validatedMigrations.length} migration(s)`);
    } catch (err: unknown) {
      log.error(getErrorMessage(err));
      process.exit(1);
    }
  }

  // Pre-deploy: ensure Hyperdrive is provisioned for PostgreSQL projects.
  // Migrations on disk also gate this — even if inference says needsD1: false,
  // buildVoidManifest will add the hyperdrive binding when migrations are present.
  if (dialect === 'postgresql' && (effectiveBindings.needsD1 || rawMigrations.length > 0)) {
    let resources: Array<ResourceSummary> | null = null;
    try {
      resources = await client.getResources(config.projectId);
    } catch {
      // Resources endpoint not available — Hyperdrive will be checked at deploy time
    }
    if (resources) {
      const hasHyperdrive = resources.some(
        (resource: ResourceSummary) => resource.type === 'hyperdrive',
      );
      if (!hasHyperdrive) {
        const { text: promptText, isCancel: isCancelPrompt } = await import('@clack/prompts');
        const connectionString = await promptText({
          message: 'Your project uses PostgreSQL. Enter your connection string:',
          placeholder: 'postgresql://user:pass@host:5432/dbname',
          validate(value) {
            if (!value?.startsWith('postgres://') && !value?.startsWith('postgresql://')) {
              return 'Must start with "postgres://" or "postgresql://"';
            }
          },
        });
        if (isCancelPrompt(connectionString)) {
          log.info('Deploy cancelled.');
          process.exit(0);
        }
        await client.provisionDatabase(config.projectId, connectionString as string);
        log.success('Hyperdrive provisioned.');
      }
    }
  }
  const workerDirName = resolveWorkerDirName(distDir, fwPreset, frameworkBuildCmd);

  const rawJobs = scanJobsSync(root, paths.cronsDir);
  const rawQueues = scanQueuesSync(root, paths.queuesDir);
  const schedules = rawJobs.flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const routeScan = await scanRoutes(root, { output: deployConfig.output, paths });
  const webSockets = routeScan.websockets ?? scanWebSocketRoutesSync(root, paths);
  const liveConfig = await resolveDeployLiveBindingConfig(root, client, config.projectId, {
    isFrameworkMode,
    needsLive: effectiveBindings.needsLive,
    webSockets,
    sandboxClassName: sandboxConfig?.className,
    cliLog,
  });
  const queues = rawQueues.map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));
  const hasPages = existsSync(paths.pagesDir);
  const hasRoutes = routeScan.routes.length > 0;
  const hasApiRoutes =
    routeScanHasApiRoutes(routeScan.routes) || routeScanHasApiRoutes(webSockets) || authEnabled;
  const hasDocumentRoutes = routeScanHasDocumentRoutes(routeScan.routes);
  const hasMiddleware = routeScan.middleware.length > 0;
  const hasWebSockets = webSockets.length > 0;
  const isSsr = isFrameworkMode
    ? true
    : Boolean(validateSsrEntry(root, paths)) || (hasPages && deployConfig.output !== 'static');

  // Resolve revalidate config from void.json + per-page .server.ts exports.
  // The page scan is also reused by the fully-static optimization below.
  const pageScan = existsSync(paths.pagesDir)
    ? routeScan.pages.pages.length > 0
      ? routeScan.pages
      : await scanPages(root, { output: deployConfig.output, paths })
    : null;
  const revalidate = collectRevalidate(deployConfig, pageScan);

  // Fully-static optimization: if output: "static" and all pages are prerendered
  // with no backend features, deploy as a static site (no worker needed)
  if (deployConfig.output === 'static' && pageScan && !isSsr) {
    const allPrerenderable = pageScan.pages.every(
      (p) =>
        p.shouldPrerender && ((p.params.length === 0 && !p.catchAll) || p.hasGetPrerenderPaths),
    );
    const hasNonPageBackend =
      hasRoutes || hasMiddleware || hasWebSockets || authEnabled || liveConfig !== undefined;
    if (allPrerenderable && !hasNonPageBackend && schedules.length === 0 && queues.length === 0) {
      log.info('All pages prerendered — deploying as static site');
      cliLog?.info('full_to_static_redirect', { reason: 'all_pages_prerendered' });
      return runStaticDeploy(
        root,
        config,
        client,
        {
          buildCommand: null,
          outputDir: clientDir,
          appType: 'static',
        },
        true,
        gitMetadata,
        assetsPrefix,
        headerRules,
        redirectRules,
        fallbackRules,
        undefined,
        cliLog,
      );
    }
  }

  // Resolve prerender paths. Skip in two cases:
  //   - output: "static" — pages are already built as static assets.
  //   - framework mode (Class A) — the framework's own worker entry has no
  //     /__void/prerender-paths endpoint (only compileWorkerEntry /
  //     compileNodeApp emit it for Void apps). Class-A frameworks handle
  //     prerendering through their own build pipelines.
  const uniquePrerenderPaths =
    deployConfig.output === 'static' || isFrameworkMode
      ? []
      : isNodeTarget(deployConfig.target)
        ? await collectPrerenderPathsNode({
            root,
            ssrDir: join(distDir, 'ssr'),
            clientDir,
          })
        : await collectPrerenderPaths({
            root,
            workerDir: join(distDir, workerDirName),
            clientDir,
            persistDir: join(root, '.void'),
            // Match the runtime remote-mode switch so getPrerenderPaths()
            // reads real D1/KV/R2 during deploy-time path discovery when
            // the project is in remote mode. Without this the manifest
            // would be built from local bindings even for remote projects.
            remoteMode: resolveRemoteMode(deployConfig.remote),
            projectId: config.projectId,
          });

  // 8. Read wrangler compat settings for Cloudflare targets
  const wranglerCompat = resolveDeployWranglerCompat(
    root,
    deployConfig,
    join(distDir, workerDirName),
    {
      authEnabled,
      dialect,
      needsSandbox: effectiveBindings.needsSandbox,
    },
  );
  const workerMain = resolveDeployWorkerMain(deployConfig, join(distDir, workerDirName));

  // 9. Load .env vars for production (excludes .local files)
  const envVars = loadDeployEnv(root);

  // 9a. Validate against env.ts schema if present.
  await assertEnvSchemaValid(root, client, config.projectId);

  // 9b. Overlay schema `.default(value)` entries for keys not set in
  //     .env files so the deployed worker sees the same fallback as the
  //     typed `env.X` proxy.
  await applySchemaDefaultsToVars(root, envVars);

  // 10. Package & Upload
  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  const assetConfig: AssetConfig = resolveAssetConfig({
    isSsr,
    hasPages,
    hasApiRoutes,
    hasDocumentRoutes,
    hasMiddleware,
    hasWebSockets: routeScanHasDocumentRoutes(webSockets),
    authEnabled,
    liveEnabled: liveConfig !== undefined,
  });

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` carries the in-memory buffer cache through to the upload
  // step so each asset is read from disk exactly once (Codex Finding #2).
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: clientDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(clientDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', {
    mode: 'full',
    isSsr,
    hasRoutes,
    hasMiddleware,
    hasWebSockets,
    authEnabled,
    framework: detected?.name,
  });
  const packageStartedAt = Date.now();
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const voidPackageOptions = {
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
    ...(workerMain && { workerMain }),
    ...(sandboxConfig && { sandbox: sandboxConfig }),
    ...(liveConfig && { live: liveConfig }),
    revalidateQueryAllowlist: deployConfig.routing?.revalidateQueryAllowlist,
  };

  // Surface the non-SPA-fallbacks mismatch (if any) before invoking the
  // I/O-free manifest builder.
  const fallbackWarning = detectNonSpaFallbackWarning(assetConfig, fallbackRules);
  if (fallbackWarning) {
    onProgress?.(fallbackWarning);
    console.warn(`[void] ${fallbackWarning}`);
  }

  const manifest = assembleVoidManifest(
    pageScan,
    isFrameworkMode,
    {
      bindings: liveConfig ? { ...effectiveBindings, needsLive: true } : effectiveBindings,
      migrations: validatedMigrations,
      schedules,
      ssr: isSsr || hasRoutes || hasMiddleware || hasWebSockets || authEnabled,
      framework: isFrameworkMode ? detected!.name : undefined,
      revalidate,
      vars: envVars,
      queues,
      prerender: uniquePrerenderPaths,
      assetConfig,
      options: voidPackageOptions,
      hashedAssetsPrefix: assetsPrefix,
      headerRules,
      redirectRules,
      fallbackRules,
      dialect,
      webSockets,
    },
    deployConfig.routing?.revalidate,
  );
  const workerDir = join(distDir, workerDirName);
  if (isFrameworkMode) {
    const wrapperFeatures: WrapperFeatures = {
      auth: null,
      crons: rawJobs,
      queues: rawQueues,
      hasMigrations: validatedMigrations != null && validatedMigrations.length > 0,
      migrationDialect: dialect,
    };
    if (needsWrapper(wrapperFeatures)) {
      log.step('Generating wrapper...');
      await generateDeployWrapperIfNeeded(
        root,
        workerDir,
        fwPreset?.workerMain ?? 'index.js',
        wrapperFeatures,
      );
      log.info('Wrapper generated');
    }
  }
  const workerFiles = collectWorkerFiles(workerDir);
  assertWorkerMainUploaded(workerFiles, workerMain);
  cliLog?.info('package_end', {
    mode: 'full',
    durationMs: Date.now() - packageStartedAt,
  });
  const result = await streamDirectR2Deploy(
    client,
    config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    neededSet !== null,
    workerFiles,
    s,
    cliLog,
  );

  const summary = [
    `${result.workers} worker module(s), ${formatKnownAssetSummary(result, skipped)}`,
  ];
  if (result.migrations) {
    summary.push(`${result.migrations} migration(s) applied`);
  }
  if (schedules.length > 0) {
    summary.push(`${schedules.length} cron job(s) scheduled`);
  }
  if (queues.length > 0) {
    summary.push(`${queues.length} queue(s) configured`);
  }
  if (uniquePrerenderPaths.length > 0) {
    summary.push(`${uniquePrerenderPaths.length} page(s) prerendered`);
  }
  if (isSsr) {
    summary.push('SSR enabled');
  }
  if (revalidate) {
    if (typeof revalidate === 'number') {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
  }
  if (isFrameworkMode) {
    summary.push('Framework mode');
  }
  note(summary.join('\n'), result.url);

  warnUnpublishedRouting(result);
  outro('Done!');
}

async function createProjectFromSlug(
  root: string,
  client: PlatformClient,
  slug: string,
  cliLog?: CliLogger,
): Promise<ProjectConfig> {
  log.step(`Creating project ${pc.blue(slug)}...`);
  cliLog?.info('project_create_start', { slug });
  const project = await client.createProject(slug);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  log.success(`Project created: ${pc.blue(config.slug)}`);
  cliLog?.info('project_create_success', { projectId: config.projectId, slug: config.slug });
  return config;
}

function getGitCommit(root: string): string | null {
  try {
    const githubSha = process.env.GITHUB_SHA?.trim();
    if (githubSha && /^[0-9a-f]{7,64}$/i.test(githubSha)) {
      return githubSha;
    }

    // `git status` can invoke a repo-configured `core.fsmonitor` hook, so keep
    // the CF Access service-token pair out of these git children too (matches
    // the build spawns and the prior global env scrub).
    const gitEnv = buildEnv();
    // Check if in a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore', env: gitEnv });
    // Check if working tree is clean
    const status = execSync('git status --porcelain', {
      cwd: root,
      encoding: 'utf-8',
      env: gitEnv,
    }).trim();
    if (status !== '') {
      return null;
    }
    // Get current commit hash
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', env: gitEnv }).trim();
  } catch {
    return null;
  }
}

function assertDeploySchemaDriftFree(root: string, dialect: DatabaseDialect): void {
  try {
    if (!hasDeploySchemaDrift(root, dialect)) {
      return;
    }
  } catch (error: unknown) {
    log.error(getErrorMessage(error));
    process.exit(1);
  }

  log.error(getDeploySchemaDriftMessage());
  process.exit(1);
}

export function hasDeploySchemaDrift(root: string, dialect: DatabaseDialect): boolean {
  if (!discoverSchema(root, readProjectPaths(root))) {
    return false;
  }

  const driftRoot = mkDeployDriftCheckRoot(root);
  const driftProjectRoot = join(driftRoot, 'project');

  createDeployDriftProject(root, driftProjectRoot);

  try {
    const migrationsDir = readProjectPaths(driftProjectRoot).migrationsDir;
    const before = snapshotDir(migrationsDir);
    const driftConfigPath = writeDrizzleConfig(
      driftProjectRoot,
      dialect === 'postgresql' ? 'postgresql://dummy' : ':memory:',
      dialect,
    );

    const output = runDrizzleKitGenerate(driftProjectRoot, driftConfigPath);
    const after = snapshotDir(migrationsDir);
    const snapshotsEqual = migrationSnapshotsEqual(before, after);

    if (snapshotsEqual && !output.includes('No schema changes, nothing to migrate')) {
      throw new Error(output || 'drizzle-kit generate finished without reporting schema status.');
    }

    return !snapshotsEqual;
  } catch (error) {
    throw new Error(formatDeploySchemaDriftCheckError(error));
  } finally {
    rmSync(driftRoot, { recursive: true, force: true });
    cleanupDeployDriftCheckRoot(root);
  }
}

function runDrizzleKitGenerate(root: string, configPath: string): string {
  const result = spawnSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    encoding: 'utf-8',
    // drizzle-kit loads the user's drizzle config + schema (user code); keep the
    // CF Access service token out of it, matching the build spawns.
    env: buildEnv(),
  });
  const stderr = bufferToString(result.stderr);
  const stdout = bufferToString(result.stdout);
  const output = [stderr, stdout].filter(Boolean).join('\n').trim();

  if (result.error) {
    throw result.error;
  }
  if (stderr) {
    throw new Error(output);
  }
  if (result.status !== 0) {
    throw new Error(output || `drizzle-kit generate exited with code ${result.status}.`);
  }

  return output;
}

function getDeploySchemaDriftMessage(): string {
  return [
    'Schema drift detected between your Drizzle schema and db/migrations/.',
    'Run `void db generate`, review the generated migration, commit it yourself, then rerun `void deploy`.',
  ].join('\n');
}

function formatDeploySchemaDriftCheckError(error: unknown): string {
  const detail = extractExecErrorOutput(error);
  return [
    'Failed to check Drizzle schema drift during deploy.',
    'Run `void db generate` locally, fix any reported issues, review the generated migration, commit it yourself, then rerun `void deploy`.',
    ...(detail ? [detail] : []),
  ].join('\n\n');
}

function extractExecErrorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const details = [];
  const stderr = 'stderr' in error ? bufferToString(error.stderr) : '';
  const stdout = 'stdout' in error ? bufferToString(error.stdout) : '';

  if (stderr) {
    details.push(stderr);
  }
  if (stdout) {
    details.push(stdout);
  }
  const message = 'message' in error ? bufferToString(error.message) : '';
  if (details.length === 0 && message) {
    details.push(message);
  }

  return details.join('\n').trim();
}

function bufferToString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value instanceof Buffer) {
    return value.toString('utf-8').trim();
  }
  return '';
}

function createDeployDriftProject(root: string, driftProjectRoot: string): void {
  mkdirSync(driftProjectRoot, { recursive: true });

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.void' || entry.name === 'node_modules') {
      continue;
    }
    if (
      entry.name === 'dist' ||
      entry.name === 'build' ||
      entry.name === '.wrangler' ||
      entry.name === '.turbo' ||
      entry.name === '.next' ||
      entry.name === '.svelte-kit' ||
      entry.name === '.output'
    ) {
      continue;
    }

    const source = join(root, entry.name);
    const target = join(driftProjectRoot, entry.name);

    cpSync(source, target, { recursive: true });
  }
}

function mkDeployDriftCheckRoot(root: string): string {
  const driftCheckDir = join(root, deployDriftCheckDir);
  rmSync(driftCheckDir, { recursive: true, force: true });
  mkdirSync(driftCheckDir, { recursive: true });
  return mkdtempSync(join(driftCheckDir, 'check-'));
}

function cleanupDeployDriftCheckRoot(root: string): void {
  const driftCheckDir = join(root, deployDriftCheckDir);
  try {
    if (existsSync(driftCheckDir) && readdirSync(driftCheckDir).length === 0) {
      rmSync(driftCheckDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only. The deploy drift check must not mask
    // the original Drizzle Kit error with a cleanup failure.
  }
}

function snapshotDir(root: string): Record<string, string> {
  if (!existsSync(root)) {
    return {};
  }

  const snapshot: Record<string, string> = {};
  collectSnapshotFiles(root, root, snapshot);
  return snapshot;
}

function collectSnapshotFiles(
  current: string,
  root: string,
  snapshot: Record<string, string>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectSnapshotFiles(fullPath, root, snapshot);
      continue;
    }
    snapshot[relative(root, fullPath)] = readFileSync(fullPath, 'utf-8');
  }
}

function migrationSnapshotsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftPath, leftContent], index) => {
    const [rightPath, rightContent] = rightEntries[index] ?? [];
    return leftPath === rightPath && leftContent === rightContent;
  });
}

/**
 * Overlay schema `.default(value)` entries onto the deploy manifest vars so
 * the deployed worker sees the same fallback as the typed `env.X` proxy at
 * runtime. User-provided `.env*` values always win — defaults only fill
 * gaps. No-op when the project has no `env.ts`.
 */
async function applySchemaDefaultsToVars(
  root: string,
  envVars: Record<string, string>,
): Promise<void> {
  const defaults = await getDeployEnvDefaults(root);
  for (const [key, value] of Object.entries(defaults)) {
    if (envVars[key] === undefined) {
      envVars[key] = value;
    }
  }
}

/**
 * If the project has an `env.ts`, validate its schema against the union of
 * production env files and remote secret names. Hard-error before upload so
 * deploys never ship missing required env vars.
 */
async function assertEnvSchemaValid(
  root: string,
  client: PlatformClient,
  projectId: string,
): Promise<void> {
  // Skip the remote secret round-trip when the project has no typed env schema.
  if (findEnvFile(root) == null) {
    return;
  }

  const remoteSecrets = await fetchRemoteSecretNames(client, projectId);
  const { hasSchema, report } = await validateProdEnv(root, {
    productionOnly: true,
    remoteSecrets,
  });
  if (!hasSchema || report.valid) {
    return;
  }

  const formatted = formatEnvReport(report);
  log.error(`Env validation failed:\n${formatted}`);
  if (report.missing.length > 0) {
    log.info(
      `Add the missing values to .env / .env.production, or upload them with \`void secret put <NAME>\`.`,
    );
  }
  throw new DeployEventError('deploy: Aborting because env.ts schema is not satisfied.');
}

/**
 * Load env vars for deploy — only .env and .env.production (not .local files).
 * Later files win on conflict.
 */
export function loadDeployEnv(root: string): Record<string, string> {
  // Same parse + merge + expand path env validation uses, so the shipped
  // values match what was validated.
  const files = ['.env', '.env.production'];
  const parsed = files.map((file) => parseDotenvFile(join(root, file), { expand: false }));
  const env = mergeAndExpand(parsed, { onWarn: (msg) => voidWarn(msg) });
  const { sanitized, stripped } = stripInternalEnvKeys(env);
  if (stripped.length > 0) {
    voidWarn(
      `Ignoring internal env keys from .env files: ${stripped.join(', ')}. These are reserved for Void runtime use and will not be shipped in the deploy manifest.`,
    );
  }
  return sanitized;
}

/**
 * Resolve the top-level build output directory.
 *
 * When a framework preset is available, uses its workerDir to derive the
 * parent directory (e.g. "build/server" → "build"). This gives framework-
 * specific error messages when the output is missing.
 *
 * For non-framework (Void app) deploys, defaults to "dist".
 */
export function resolveDistDir(
  root: string,
  fwPreset?: FrameworkPreset,
  buildCommand?: string,
): string {
  if (fwPreset) {
    // Derive the top-level build dir from the preset's workerDir
    // e.g. "build/server" → "build", "dist/ssr" → "dist"
    const topDir = fwPreset.workerDir.split('/')[0];
    const distDir = join(root, topDir);
    if (!existsSync(distDir)) {
      throw new Error(
        `deploy: Build output directory '${topDir}' not found. Run '${buildCommand ?? fwPreset.buildCommand}' first.`,
      );
    }
    return distDir;
  }
  return join(root, 'dist');
}

/**
 * Resolve the worker output subdirectory name within the build dir.
 *
 * When a framework preset is available, uses the preset's workerDir to
 * derive the subdirectory name and gives a framework-specific error.
 *
 * For non-framework (Void app) deploys, probes for known subdirectories.
 */
export function resolveWorkerDirName(
  distDir: string,
  fwPreset?: FrameworkPreset,
  buildCommand?: string,
): string {
  if (fwPreset) {
    // Derive the subdirectory from the preset's workerDir
    // e.g. "build/server" → "server", "dist/ssr" → "ssr"
    const parts = fwPreset.workerDir.split('/');
    const subDir = parts.slice(1).join('/');
    if (!existsSync(join(distDir, subDir))) {
      throw new Error(
        `deploy: Worker output '${fwPreset.workerDir}' not found. Run '${buildCommand ?? fwPreset.buildCommand}' first.`,
      );
    }
    return subDir;
  }

  // Non-framework: probe for known output subdirectories
  for (const name of ['ssr', 'rsc', 'server']) {
    if (existsSync(join(distDir, name))) {
      return name;
    }
  }
  throw new Error('deploy: Worker output not found. Expected dist/ssr/ or dist/rsc/.');
}
