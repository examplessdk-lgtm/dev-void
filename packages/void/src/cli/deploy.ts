import { execSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isCI as ciInfoIsCI } from 'ci-info';
import { Minimatch } from 'minimatch';
import { basename, dirname, join, normalize, relative, resolve } from 'pathslash';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const deployDriftCheckDir = join('.void', 'deploy-drift-check');
import {
  intro,
  outro,
  log as clackLog,
  note,
  confirm,
  isCancel,
  select,
  type SpinnerResult,
} from '@clack/prompts';
import {
  CloudflareWorkerInspectionError,
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  readBindingFieldPresence,
  readConfigEntryString as readD1EntryString,
  readStoredResourceName,
  readWranglerTopLevelString,
  renderCloudflareStaticEntry,
  resolveD1MigrateTarget,
  stageCloudflareStaticAssets,
  writeCloudflareFrameworkDeployConfig,
  writeCloudflareStaticDeployConfig,
  readExistingCloudflareWorker,
  assertCloudflareDurableObjectLifecycleSupported,
  assertExistingCloudflareConfig,
  assertCloudflareBindingsPreserved,
  type ExistingCloudflareWorker,
  type CloudflareCommandResult,
  type CloudflareOperation,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { createDeployArtifact, createDeployUploadPayload } from '@void/deploy-core';
import { analyzeApplicationSync, type ApplicationAnalysis } from '../application-analysis.ts';
import { analyzeApplication, completeApplicationAnalysis } from '../application-routing.ts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetConfig,
} from '../asset-routing.ts';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import {
  materializeCloudflareConfig,
  MATERIALIZED_CLOUDFLARE_FILE,
  stashCloudflareDeployPointer,
} from '../cloudflare-config.ts';
import { findEnvFile } from '../codegen/env-types.ts';
import {
  readConfig,
  resolveBindingNames,
  type DatabaseDialect,
  type NotFoundHandling,
  type RoutingConfig,
  type VoidConfig,
  isNodeTarget,
} from '../config.ts';
import { writeDrizzleConfig } from '../drizzle/config.ts';
import { discoverSchema } from '../drizzle/discover.ts';
import { scanDurableObjectModules } from '../durable/scan.ts';
import { collectRevalidate, collectPages, hasRevalidate } from '../isr-config.ts';
import { voidWarn } from '../log.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { runMySqlMigrations } from '../migrations/runner-mysql.ts';
import { runPgMigrations } from '../migrations/runner-pg.ts';
import {
  openMigrationValidationDatabase,
  SqliteMigrationError,
} from '../migrations/sqlite-validation.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import type { PageScanResult } from '../pages/types.ts';
import { detectFramework, type DetectedFramework } from '../plugin-inference.ts';
import {
  collectPrerenderPaths,
  collectPrerenderPathsNode,
  prerenderPages,
  prerenderPagesNode,
} from '../prerender.ts';
import { readProjectPaths } from '../project-paths.ts';
import { hasEmailHandlers, type EmailHandlersScan } from '../router/email.ts';
import {
  assertSandboxNamespaceConfig,
  requiresSandboxPlatformImage,
  resolveSandboxConfig,
  sandboxContainerConfig,
  SANDBOX_MIGRATION_TAG,
  hasSandboxSqliteMigration,
} from '../sandbox/config.ts';
import { trustedCloudflareWorkerAccessHeaders } from '../shared/cf-access.ts';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV, resolveRemoteMode } from '../shared/env.ts';
import { buildEnv, WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../shared/untrusted-env.ts';
import {
  CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  readVersionMetadataBinding,
  selectNativeVersionMetadataBinding,
} from '../shared/version-metadata.ts';
import { validateSsrEntry } from '../ssr/entry.ts';
import { getApiUrl, getToken, getTokenSource } from './auth.ts';
import {
  prepareCfBuildOutput,
  prepareCfFrameworkBuildOutput,
  prepareCfStaticBuildOutput,
} from './cf-build-output.ts';
import {
  createActiveSecretPinner,
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
} from './cf-version-runner.ts';
import {
  isExpiredTokenError,
  PlatformClient,
  type DeploymentResponse,
  type ManifestOnlyDeployPayload,
  type ProjectResponse,
} from './client.ts';
import {
  CloudflareAuthenticationError,
  cloudflareCredentialOverrides,
  ensureCloudflareAuthentication,
  parseCloudflareAuthSession,
} from './cloudflare-auth.ts';
import {
  assertCloudflareCandidateUnchanged,
  clearCloudflareCandidate,
  readCloudflareCandidate,
  recordCloudflareCandidateUpload,
  type CloudflareCandidateReceipt,
} from './cloudflare-candidate.ts';
import { classifyCloudflareDeployApp } from './cloudflare-deploy/classify.ts';
import { approvedCloudflareIsrBinding, chooseCloudflareIsr } from './cloudflare-isr.ts';
import {
  maybeLinkCloudflareDeploy,
  readCloudflareLink,
  prepareExistingCloudflareDeploy,
  completeCloudflareLink,
  recordCloudflareCandidate,
  assertCloudflareLinkUnchanged,
  type CloudflareLink,
} from './cloudflare-link.ts';
import {
  createCloudflareEmptyCronPublisher,
  createCloudflareEmptyDomainPublisher,
} from './cloudflare-operations.ts';
import { createCloudflareProcessRunner } from './cloudflare-process.ts';
import {
  rememberCloudflareWorkersDevSubdomain,
  resolveCloudflareWorkersDevSubdomain,
} from './cloudflare-readiness.ts';
import { formatCloudflareUserMessage } from './cloudflare-user-output.ts';
import { readGeneratedWranglerConfigFile } from './generated-wrangler-config.ts';
import { assertInstalledVoidMatchesCli } from './installed-void.ts';
import { migrateLegacyVoidConfig } from './migrate.ts';
export { parseRootWranglerConfig } from '@void/deploy-cloudflare';
import { promptAndCreateProject, reportProjectCreationWarnings } from './create-project.ts';
import {
  formatConnectionLostMessage,
  formatDeployFailureMessage,
  formatStreamDeployError,
} from './deploy-errors.ts';
import { uploadAssetsToR2, type DirectR2PutItem } from './direct-r2-upload.ts';
import {
  applyEmailSetup,
  createNodeEmailDns,
  EMAIL_FROM_VAR,
  findEmailConfigConflicts,
  preflightEmail,
  SEND_EMAIL_BINDING,
  renderAddressMap,
  renderEmailChecklist,
  type EmailCloudflareInputs,
  type EmailDns,
  type EmailFetch,
  type EmailPreflight,
} from './email-cloudflare.ts';
import type {
  EnvSchemaProbeInput,
  EnvSchemaProbeResult,
  EnvSchemaValidateResult,
} from './env-schema-probe.ts';
import {
  deriveSelfHostEnvContextFromVars,
  dischargeSelfHostEnvContext,
  fetchRemoteSecretNames,
  formatEnvReport,
  listSelfHostSecretNames,
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
import { buildDeployLogSummary } from './log-summary.ts';
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
  FRAMEWORK_PRESETS,
  formatProjectCommand,
  resolveProjectCommand,
  resolveCloudflareOperationArgv,
  type StaticPreset,
  type FrameworkPreset,
} from './preset.ts';
import {
  attachSelectedPlatform,
  readDeploymentPlatform,
  readProjectConfig,
  writeProjectConfig,
  type DeploymentPlatform,
  type ProjectConfig,
} from './project.ts';
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
export async function loadProvisionModule(): Promise<ProvisionModule> {
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
import { getRequestedProjectSlug } from './resolve-project.ts';
import type {
  AssetConfig,
  DeployEvent,
  DeployManifest,
  DeployTarget,
  DeployTargetAdapter,
  DevRedirectRule,
  HeaderRule,
} from './types.ts';
import {
  acknowledgeWranglerManagedQueueRemovals,
  readExistingLiveBindingConfig,
  readWranglerManagedQueueCleanupCandidates,
  readWranglerPublishedTrafficSnapshot,
  normalizeWranglerCompatibilityFlags,
  ensureWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  writeProvisionedWranglerConfig,
  writeWranglerPublishedTrafficSnapshot,
  bindingEntriesForField,
  FRIENDLY_BINDING_NAMES,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  nextDurableObjectMigrationTag,
  type LiveBindingConfig,
  type ProvisionedWranglerPatch,
  type WranglerCompat,
} from './wrangler.ts';

const log = {
  error: (message: string) => clackLog.error(formatCloudflareUserMessage(message)),
  info: (message: string) => clackLog.info(formatCloudflareUserMessage(message)),
  message: (message: string) => clackLog.message(formatCloudflareUserMessage(message)),
  step: (message: string) => clackLog.step(formatCloudflareUserMessage(message)),
  success: (message: string) => clackLog.success(formatCloudflareUserMessage(message)),
  warn: (message: string) => clackLog.warn(formatCloudflareUserMessage(message)),
};
import { needsWrapper, generateWrapper, bundleEntry, cleanupWrapper } from './wrapper.ts';

class DeployEventError extends Error {}
import type { WrapperFeatures } from './wrapper.ts';

export type RunDeployOptions = {
  /** Accepted the existing-Worker handoff in this invocation. */
  reuseExistingWorker?: boolean;
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
  debug?: boolean;
  platform?: Exclude<DeploymentPlatform, 'none'>;
  provision?: boolean;
  /**
   * Mode B email (0078): fail the deploy — before any upload — instead of continuing
   * without email when the mail domain is not set up and the step cannot finish it
   * (CI / non-TTY, a blocker, a declined prompt). `--platform cloudflare` only.
   */
  requireEmail?: boolean;
  /** Publish an existing Durable Object Worker atomically after explicit operator choice. */
  atomic?: boolean;
};

export function resolveDeploymentPlatform(
  root: string,
  options?: RunDeployOptions,
): DeploymentPlatform {
  return options?.platform ?? readDeploymentPlatform(root) ?? 'void';
}

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
      (requirements?.dialect !== undefined && requirements.dialect !== 'sqlite') ||
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
    // Flush before reading the file back. The `Detailed log:` path is useless
    // on a CI runner that is destroyed with the job, so inline the errors and
    // the trailing timeline into the message the caller prints.
    await cliLog.close().catch(() => {});
    try {
      if (err instanceof Error) {
        const summary = buildDeployLogSummary(cliLog.path);
        if (summary) {
          err.message = `${err.message}\n${summary}`;
        }
      }
    } catch {
      // A postmortem aid must never replace the failure it describes. The
      // assignment alone can throw: `message` is read-only on a frozen Error
      // and getter-only on a DOMException, which an aborted fetch produces.
      // Losing the summary is fine; losing the deploy error is not.
    }
    throw err;
  } finally {
    await cliLog.close().catch(() => {});
  }
}

/**
 * Build a child-process environment with deployment credentials removed.
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
 * the trusted readiness-header capture / cloudflared pair-guard AFTER the build
 * step. Managed prerender runs later in this trusted parent process with a
 * dedicated short-lived proxy credential. The deploy token, Cloudflare,
 * Access, and production database credentials never reach arbitrary build
 * scripts or plugins.
 *
 * `localBinRoot` is an explicit OPT-IN, not a default. Build commands are run
 * through a shell (`execSync`) and a user-configured `inference.build` (e.g.
 * `vitepress build && vite build`) names bare binaries that only exist in the
 * project's own `node_modules/.bin`; under the build container's
 * `npx --yes void deploy` that happens to work — npx prepends every ancestor
 * `.bin` itself — but a directly invoked `node_modules/.bin/void deploy` or a
 * globally installed `void` inherits no such PATH and the bare binary fails to
 * resolve. Passing it makes the project's bin dir shadow the system one for
 * that child, so it belongs ONLY on the three build execs. The other callers
 * (`getGitCommit`, the drizzle-kit spawn) exec a system binary or an absolute
 * path and must not hand a dependency-shipped `node_modules/.bin/git` a child
 * process holding `VOID_TOKEN`.
 */
export { buildEnv } from '../shared/untrusted-env.ts';

/**
 * Marks a build child as driven by a MANAGED `void deploy`.
 *
 * The platform resolves the asset routing policy out-of-band (`resolveAssetConfig`
 * → `manifest.assetConfig`) and applies it to the uploaded script, so settings the
 * Vite plugin cannot safely write into the built wrangler config — `routing.notFound`
 * for a Class A framework, which needs an `assets` policy Void does not own there —
 * are still honored on this path. `void:framework-build-wrapper` warns about exactly
 * those when this flag is ABSENT, i.e. on a self-hosted `vite build && wrangler deploy`.
 *
 * Passed through the CHILD env only (never `process.env`), the same way
 * `VOID_DEPLOY_PROJECT_ID` is, so it cannot leak into an unrelated child process or a
 * later `void dev` in the same shell.
 *
 * Deliberately NOT set by `runCloudflareDeploy` (`--platform cloudflare`): that flow
 * hands the built output to `wrangler deploy` against the user's own account and IS the
 * self-host path the warning is about. (It rejects framework SSR outright today, so no
 * Class A build reaches it either way.)
 */
const MANAGED_DEPLOY_BUILD_ENV = { VOID_DEPLOY_BUILD: '1' } as const;

/** Remove managed-only build markers from an explicit native Cloudflare child. */
function scrubManagedDeployBuildMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { deleteEnvVarCaseAware } = requireProvisionModule();
  deleteEnvVarCaseAware(env, 'VOID_DEPLOY_PROJECT_ID');
  deleteEnvVarCaseAware(env, CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV);
  for (const name of Object.keys(MANAGED_DEPLOY_BUILD_ENV)) {
    deleteEnvVarCaseAware(env, name);
  }
  return env;
}

/**
 * Deploy-time env selectors that pin the WRONG worker/config out from under the
 * top-level config this flow provisions + preflights. Scrubbed from every child env
 * and fenced in the project dotenv (see below), on top of the provisioner's transport
 * scrub/fence which owns the endpoint-redirect + `CLOUDFLARE_ENV` vars:
 *   - `WRANGLER_CI_OVERRIDE_NAME` — wrangler 4.131 applies it AFTER config load
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
 * The dotenv files wrangler 4.131 reloads into `process.env` (`override: true`) for
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
      'CLOUDFLARE_ENV is set. --platform cloudflare deploys the TOP-LEVEL environment of ' +
        'your root wrangler config only (a named environment can carry a different account, ' +
        'worker name, or binding set). Unset CLOUDFLARE_ENV and retry.',
    );
  }
  const configPathOverride = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
  if (typeof configPathOverride === 'string' && configPathOverride.trim().length > 0) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. --platform cloudflare builds from the ' +
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
export function resolveDeployTransport(root: string, rootConfig: Record<string, unknown>): string {
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
 *
 * This is the env {@link createDeployWranglerRunner} spawns `whoami` / `d1 migrations apply`
 * / `deploy` with, so it deliberately KEEPS the wrangler-auth credentials — only the
 * untrusted-code children layer {@link scrubWranglerAuthCredentials} on top. Exported so a
 * test can assert that directly.
 */
export function deployChildEnv(
  accountId: string | undefined,
  apiBaseUrl: string,
): NodeJS.ProcessEnv {
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
  // Void owns the browser OAuth lifecycle. Never allow Wrangler to fall back to
  // its plaintext credential file while a Void command is using that session.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
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

/**
 * A pin of every desired id-bearing binding's IDENTITY, keyed `<field>:<binding>` (the config
 * section joined to the binding — both fixed/identifier-shaped, so the pair never collides),
 * captured from the root config AFTER provision/drift resolves every real id and BEFORE the
 * untrusted `vite build` runs. The remote-migrate assert and the emitted-config check both
 * compare against THIS map, so the id defense is symmetric with the pinned `account_id` — see
 * {@link snapshotBindingIdentities}.
 */
export type BindingIdentitySnapshot = Map<string, string>;

/**
 * The snapshot/lookup key for one binding identity. `field` is one of a fixed set of wrangler
 * config sections (`d1_databases` / `kv_namespaces` / `r2_buckets` / `hyperdrive`) and `binding`
 * is a wrangler binding name (an identifier — no `:`), so the joined key is collision-free.
 */
function bindingIdentityKey(field: string, binding: string): string {
  return `${field}:${binding}`;
}

/**
 * Enumerate EVERY id-bearing binding DECLARED in `config` across the four id-bearing sections
 * (`d1_databases` / `kv_namespaces` / `r2_buckets` / `hyperdrive`), as `{ field, binding, id }`.
 * `id` is `undefined` when the entry omits it or leaves it empty (never pinned, never asserted —
 * the same "absent or empty → undefined" collapse as {@link readStoredResourceName}). Reads each
 * entry on its OWN terms (never a first-match re-scan) so a duplicated / appended entry is seen as
 * itself. Section + id-field names come from {@link DEPLOY_BINDING_IDENTITY_FIELDS} — no per-kind
 * branching. Unlike {@link desiredIdentityBindings} this is NOT restricted to the desired set: it
 * captures a user's hand-declared extra binding too, which is exactly what lets the completeness
 * check tell a pre-existing binding apart from one the build injected.
 */
function collectConfigBindingIdentities(
  config: Record<string, unknown>,
): Array<{ field: string; binding: string; id: string | undefined }> {
  const out: Array<{ field: string; binding: string; id: string | undefined }> = [];
  for (const { field, idField } of Object.values(DEPLOY_BINDING_IDENTITY_FIELDS)) {
    const list = config[field];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const binding = readD1EntryString(entry, 'binding');
      if (binding === undefined) {
        continue;
      }
      out.push({ field, binding, id: readD1EntryString(entry, idField) });
    }
  }
  return out;
}

/**
 * Snapshot the real, id-bearing identity of EVERY binding declared in the root `config` into an
 * in-memory map — the id defense's ground truth, mirroring the pinned in-memory `accountId`.
 *
 * Taken AFTER provision (which writes each real id into the root config via
 * `wrangler <res> create --update-config`) and the `name`/`account_id` reconcile, and BEFORE
 * the build. `vite build` runs untrusted project code with its Cloudflare credentials scrubbed,
 * so a compromised build dependency can only edit FILES — it could rewrite
 * `wrangler.jsonc`'s `d1_databases[<binding>].database_id` (keeping the binding + database_name)
 * to redirect the privileged remote D1 migrate or the deploy to a DIFFERENT same-account
 * resource, OR ADD a wholly new id-bearing binding (`EXTRA_DB`/`EXTRA_KV`/…) that the CF plugin
 * would then merge verbatim into `dist/ssr/wrangler.json`. Snapshotting EVERY declared id here —
 * not only the desired ones — and asserting the post-build config + emitted artifact carry
 * exactly this set closes both gaps for D1/KV/R2/Hyperdrive alike. A binding whose id is absent
 * post-drift (which the drift check already rejects for desired bindings) is simply not pinned —
 * never asserted.
 */
export function snapshotBindingIdentities(
  config: Record<string, unknown>,
): BindingIdentitySnapshot {
  const snapshot: BindingIdentitySnapshot = new Map();
  for (const { field, binding, id } of collectConfigBindingIdentities(config)) {
    if (id !== undefined) {
      snapshot.set(bindingIdentityKey(field, binding), id);
    }
  }
  return snapshot;
}

/**
 * Resource fields Void's OWN build legitimately emits into `dist/ssr/wrangler.json` — either
 * merged by `mergeBindings` (index.ts) or default-filled by the wrangler normalizer — so an entry
 * the artifact declares in one of THESE is NOT an injection and must not be asserted against the
 * pre-build root. Audited against `mergeBindings` (index.ts) + 13 real playground
 * `dist/ssr/wrangler.json` artifacts: the only {@link FRIENDLY_BINDING_NAMES} fields ever emitted
 * non-empty are these. The four id-bearing fields are excluded here because the id-pin
 * ({@link DEPLOY_BINDING_IDENTITY_FIELDS}) already pins them precisely.
 */
export const DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS: ReadonlySet<string> = new Set<string>([
  // id-pinned elsewhere (DEPLOY_BINDING_IDENTITY_FIELDS)
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'hyperdrive',
  // Void-emitted / merged by mergeBindings
  'ai',
  'durable_objects',
  'assets',
  'vars',
  // bundled content / worker self-metadata — no external-resource grant, and worker code is
  // already fully controlled by a malicious build, so pinning these adds nothing
  'data_blobs',
  'text_blobs',
  'wasm_modules',
  'version_metadata',
]);

/**
 * The pass-through assert-set: every binding field wrangler knows about
 * ({@link FRIENDLY_BINDING_NAMES}, Void's authoritative transcription of wrangler's binding
 * registry) that Void does NOT itself emit. An entry the EMITTED artifact declares in one of
 * these is either a verbatim pass-through of the user's OWN root config (captured in the pre-build
 * snapshot) or a build-time INJECTION — the latter would grant the deployed worker a same-account
 * capability the source never asked for (a `services` binding to another worker, a
 * `secrets_store_secrets` handle, a `dispatch_namespaces` entry, an `unsafe` binding of an
 * arbitrary type, …), which the CF plugin passes through into the emitted config and the
 * credentialed `wrangler deploy` then binds.
 *
 * Complete-by-construction against the known registry: it auto-covers every capability field
 * (browser/images/stream/media/websearch/unsafe included) and any FUTURE field added to the
 * registry fails CLOSED — a new registry field is asserted until explicitly excluded here. Fields
 * wrangler does not yet know about are absent from the registry and still fail OPEN — the same
 * residual the id-pin has, so a future resource field can never false-positive a legitimate build.
 */
export const DEPLOY_PASSTHROUGH_ASSERT_FIELDS: ReadonlyArray<string> = Object.keys(
  FRIENDLY_BINDING_NAMES,
).filter((field) => !DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS.has(field));

/**
 * Fields the CF plugin passes through VERBATIM that the per-binding ENTRY pin cannot cover, so
 * each is compared WHOLE against the raw pre-build root value instead:
 *   - `unsafe` — is in {@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS} (so it stays in the drift
 *     invariant) but its `.metadata`/`.capnp` are never entry-iterated, and wrangler applies
 *     `unsafe.metadata` LAST at upload, OVERWRITING the whole uploaded bindings array — so an
 *     entry-level pin is blind to it. Routed OUT of the entry loop into the whole-object pin.
 *   - `tail_consumers` / `streaming_tail_consumers` — are NOT "bindings" (absent from
 *     {@link FRIENDLY_BINDING_NAMES}), so the assert-set structurally can't see them, yet wrangler
 *     uploads them and they forward every log/request to the named worker (exfil).
 *   - `routes` / `route` / `workers_dev` / `preview_urls` — the worker's TRAFFIC attachment. A
 *     build that injects a `routes`/`route` entry attaches the deployed worker to a production
 *     hostname/path the account controls (traffic interception), and flipping `workers_dev` /
 *     `preview_urls` changes its public exposure. None is a "binding" either, so the assert-set
 *     can't see them, yet wrangler uploads them.
 *   - `addresses` — the worker's INBOUND MAIL attachment (0078 Mode B). wrangler ≥ 4.113
 *     reconciles the account's Email Routing rules from this array on `wrangler deploy`: a build
 *     that injects an address redirects the account's inbound mail to the deployed worker, and one
 *     that drops the root's removes the rules Void's email step set up. Not a binding either, and
 *     the CF plugin passes the key through verbatim, so it used to fail OPEN.
 * Void's own build emits NONE of them: a clean `vite build` (root declaring none) leaves every one
 * ABSENT from the emitted artifact (verified against a real build), so an emptiness check
 * ({@link isEmptyPassthroughValue}) keeps the normalizer's default-fill from false-positiving.
 */
export const DEPLOY_WHOLE_OBJECT_PINNED_FIELDS: ReadonlyArray<string> = [
  'unsafe',
  'tail_consumers',
  'streaming_tail_consumers',
  'routes',
  'route',
  'workers_dev',
  'preview_urls',
  'addresses',
];

/**
 * Fields whose RAW pre-build root value {@link snapshotPassthroughRawFields} captures for
 * {@link verifyGeneratedDeployConfig}'s whole-object + targeted checks: the
 * {@link DEPLOY_WHOLE_OBJECT_PINNED_FIELDS} plus `durable_objects` (external-DO check), `ai`
 * (binding pin), and `migrations` (destructive-DO-migration check). The last three are Void-emitted
 * (excluded from the assert-set) yet still need a pin because a build can add an EXTERNAL DO handle
 * (`script_name`), a rewritten/removed `ai` binding, or a DESTRUCTIVE Durable Object migration.
 */
const DEPLOY_RAW_SNAPSHOT_FIELDS: ReadonlyArray<string> = [
  ...DEPLOY_WHOLE_OBJECT_PINNED_FIELDS,
  'durable_objects',
  'ai',
  'migrations',
];

/** Void's default injected Workers AI binding name (`mergeBindings` in index.ts). */
const DEFAULT_VOID_AI_BINDING = 'AI';

/**
 * Sub-fields on a `durable_objects` binding that make it target ANOTHER worker's Durable Objects.
 * `script_name` is the one wrangler binds a cross-script DO through; `environment` narrows a
 * cross-script binding to a named environment — either marks a binding Void's own build never
 * emits (its DOs are always LOCAL `{name, class_name}`).
 */
const DURABLE_OBJECT_EXTERNAL_FIELDS = ['script_name', 'environment'];

/**
 * Keys on a wrangler `migrations` entry that DELETE or MOVE existing Durable Object classes (and
 * their stored data): `deleted_classes` drops them, `renamed_classes` renames them, and the two
 * `transferred_classes*` keys move them from another script. Void's own emitted migrations only
 * ever carry the CREATION keys (`new_classes` / `new_sqlite_classes`), never one of these — so an
 * emitted entry carrying one is a build injection that `wrangler deploy` would run against
 * production Durable Object data.
 */
const DESTRUCTIVE_MIGRATION_KEYS = [
  'deleted_classes',
  'renamed_classes',
  'transferred_classes',
  'transferred_classes_from_script',
];

/**
 * A pin of every pass-through binding's ENTRY per {@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS} field —
 * field → (bindingName → the root entry object) — captured from the root config at the SAME
 * pre-build point as {@link snapshotBindingIdentities} (after provision/drift resolves ids, before
 * the untrusted build). Lets a user's LEGITIMATELY hand-declared pass-through binding (e.g. a
 * `services` entry present before the build) survive, while an entry the build ADDED — absent from
 * this pin — OR one whose TARGET the build rewrote (same name, different service/namespace/type)
 * fails closed at {@link verifyGeneratedDeployConfig}. Entries come from each field's wrangler
 * shape via {@link bindingEntriesForField} (the SAME shapes the build's uniqueness check uses), so
 * `send_email` / `ratelimits` key on `.name` and `logfwdr` on its nested `.bindings[].name`. A
 * present field whose shape the strict reader cannot parse is recorded as an EMPTY inner map, so
 * any emitted entry in it fails closed on the symmetric read.
 */
export function snapshotPassthroughIdentities(
  config: Record<string, unknown>,
): Map<string, Map<string, Record<string, unknown>>> {
  const snapshot = new Map<string, Map<string, Record<string, unknown>>>();
  for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
    if (config[field] === undefined) {
      continue;
    }
    const entries = new Map<string, Record<string, unknown>>();
    try {
      for (const { name, entry } of bindingEntriesForField(field, config[field])) {
        entries.set(name, entry);
      }
    } catch {
      // A malformed field records an EMPTY pin, so any emitted entry in it fails closed below.
      entries.clear();
    }
    snapshot.set(field, entries);
  }
  return snapshot;
}

/**
 * Companion of {@link snapshotPassthroughIdentities} for the fields the per-binding ENTRY pin
 * cannot cover ({@link DEPLOY_RAW_SNAPSHOT_FIELDS}): capture the RAW pre-build root value for each
 * of `unsafe` / `tail_consumers` / `streaming_tail_consumers` (whole-object-pinned),
 * `durable_objects` (external-DO check), and `ai` (binding pin). Taken at the SAME pre-build point
 * as the other snapshots, so a build that INJECTS or REWRITES one of these into the emitted
 * artifact is caught at {@link verifyGeneratedDeployConfig}, while a user's own hand-declared value
 * (present here, unchanged) passes.
 */
export function snapshotPassthroughRawFields(
  config: Record<string, unknown>,
): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const field of DEPLOY_RAW_SNAPSHOT_FIELDS) {
    snapshot.set(field, config[field]);
  }
  return snapshot;
}

/**
 * Reconstruct the exact `containers` set Void's build emits into `dist/ssr/wrangler.json`, computed
 * PRE-BUILD from the SAME inputs `mergeBindings` (index.ts) uses so a legitimate build's emitted
 * entry deepEquals one reconstructed here:
 *   1. every root-declared container passes through VERBATIM (mergeBindings spreads
 *      `resolved.containers` unchanged), and
 *   2. PLUS — only when the source needs the sandbox (`needsSandbox`, the SAME
 *      `isSandboxEnabled(config) || inferProjectBindings(...).needsSandbox` signal index.ts gates
 *      emission on) AND no root-declared container already declares the sandbox class — the single
 *      Void sandbox container, built field-for-field from {@link resolveSandboxConfig} (the SAME
 *      pure function the build calls, so the reconstructed entry is byte-identical to the emitted
 *      one, absent optionals omitted).
 * A bare `wrangler deploy` PROVISIONS a container application from this array (billable, and it runs
 * the image's code), so pinning it lets {@link verifyGeneratedDeployConfig} reject a container the
 * build injected, dropped, or retargeted.
 */
export function reconstructExpectedContainers(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  needsSandbox: boolean,
): Array<Record<string, unknown>> {
  const rootContainers: Array<Record<string, unknown>> = Array.isArray(rootConfig.containers)
    ? (rootConfig.containers as Array<Record<string, unknown>>)
    : [];
  const expected: Array<Record<string, unknown>> = [...rootContainers];
  if (needsSandbox) {
    const sandbox = resolveSandboxConfig(config, root);
    const index = expected.findIndex(
      (container) => readD1EntryString(container, 'class_name') === sandbox.className,
    );
    if (index >= 0) {
      expected.splice(index, 1);
    }
    expected.push(sandboxContainerConfig(sandbox));
  }
  return expected;
}

/** Normalize only the named-image path fields Vite relocates into its output config. */
function normalizeContainerImagePaths(container: unknown, base: string): unknown {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return container;
  }
  const value = container as Record<string, unknown>;
  if (!value.images || typeof value.images !== 'object' || Array.isArray(value.images)) {
    return container;
  }
  return {
    ...value,
    images: Object.fromEntries(
      Object.entries(value.images).map(([name, source]) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          return [name, source];
        }
        const image = { ...source } as Record<string, unknown>;
        for (const key of ['dockerfile', 'build_context']) {
          if (typeof image[key] === 'string') {
            image[key] = resolve(base, image[key]);
          }
        }
        return [name, image];
      }),
    ),
  };
}

/** Reconstruct the Durable Object state emitted after the pre-build root config is synced. */
export function reconstructExpectedDurableObjectState(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  options: { needsSandbox: boolean; needsLive: boolean; analysis?: ApplicationAnalysis },
): {
  bindings: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
} {
  // classifyCloudflareDeployApp syncs WebSocket and authored Durable Object
  // modules into the root config before this snapshot. The build starts with
  // that same config, then may append its sandbox and live bindings.
  const bindings = bindingEntriesForField('durable_objects', rootConfig.durable_objects).map(
    ({ entry }) => entry,
  );
  const migrations: Array<Record<string, unknown>> = Array.isArray(rootConfig.migrations)
    ? [...(rootConfig.migrations as Array<Record<string, unknown>>)]
    : [];
  const sandbox = options.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  if (sandbox) {
    if (!bindings.some((binding) => binding.name === sandbox.binding)) {
      bindings.push({ name: sandbox.binding, class_name: sandbox.className });
    }
    if (!hasSandboxSqliteMigration(migrations, sandbox.className)) {
      migrations.push({
        tag: SANDBOX_MIGRATION_TAG,
        new_sqlite_classes: [sandbox.className],
      });
    }
  }

  const analysis = options.analysis ?? analyzeApplicationSync(root, { config });
  const websocketRoutes = analysis.allWebsockets;
  const durableObjects = analysis.durableObjects;
  const live = options.needsLive
    ? resolveLiveBindingConfig(root, {
        reservedBindings: [
          ...websocketRoutes.map((route) => route.bindingName),
          ...durableObjects.map((module) => module.bindingName),
        ],
        reservedClasses: [
          ...websocketRoutes.map((route) => route.className),
          ...durableObjects.map((module) => module.className),
          sandbox?.className,
        ],
      })
    : readExistingLiveBindingConfig(root);
  if (live) {
    if (!bindings.some((binding) => binding.name === live.bindingName)) {
      bindings.push({ name: live.bindingName, class_name: live.className });
    }
    if (!hasDurableObjectSqliteMigration(migrations, live.className)) {
      migrations.push({
        tag: nextDurableObjectMigrationTag(migrations, LIVE_MIGRATION_TAG),
        new_sqlite_classes: [live.className],
      });
    }
  }
  return { bindings, migrations };
}

/**
 * Deterministic sha256 over the wrangler uploader BUNDLE the credentialed deploy executes — the
 * resolved `wrangler-dist/cli.js` PLUS every sibling file in its directory. `cli.js` loads sibling
 * chunks from its own `__dirname` (the proxy workers, the experimental-config module), so the
 * whole directory is the trust surface, not just the entry file. Content hash of the bytes, NOT
 * mtime. Resolves the SAME entry {@link createDeployWranglerRunner} spawns (via
 * {@link resolveCloudflareOperationArgv}, whose launcher's LAST argv element is the JS entry). Returns
 * `undefined` when the entry cannot be resolved or a file cannot be read, so the caller FAILS
 * CLOSED — it never deploys a binary it could not verify. The resolver is injectable for tests.
 */
export function hashWranglerUploader(
  root: string,
  resolveArgv: (root: string) => Array<string> = resolveCloudflareOperationArgv,
): string | undefined {
  let entry: string | undefined;
  try {
    const argv = resolveArgv(root);
    entry = argv[argv.length - 1];
  } catch {
    return undefined;
  }
  if (typeof entry !== 'string' || entry.length === 0 || !existsSync(entry)) {
    return undefined;
  }
  return hashDirectoryContents(dirname(entry));
}

/** Pin the cf uploader and prebuilt-artifact builders before project code runs. */
function hashCfUploader(): string | undefined {
  try {
    const hash = createHash('sha256');
    for (const name of ['cf', '@cloudflare/config', '@cloudflare/build-output-utils', 'vite']) {
      let path = dirname(fileURLToPath(import.meta.resolve(name)));
      while (!existsSync(join(path, 'package.json'))) {
        const parent = dirname(path);
        if (parent === path) {
          return undefined;
        }
        path = parent;
      }
      const contents = hashDirectoryContents(path);
      if (!contents) {
        return undefined;
      }
      hash.update(name);
      hash.update('\0');
      hash.update(contents);
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * sha256 over every file under `dir`, walked in a STABLE (name-sorted, depth-first) order with
 * each file's relative path folded into the digest, so the hash depends only on the directory's
 * contents — never on filesystem enumeration order. Returns `undefined` on any read error.
 */
function hashDirectoryContents(dir: string): string | undefined {
  try {
    const hash = createHash('sha256');
    const visiting = new Set<string>();
    const walk = (rel: string): void => {
      const real = realpathSync(join(dir, rel));
      if (visiting.has(real)) {
        throw new Error(`Cyclic symlink in uploader: ${rel}`);
      }
      visiting.add(real);
      try {
        const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const entry of entries) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childPath = join(dir, childRel);
          if (entry.isDirectory()) {
            walk(childRel);
            continue;
          }
          hash.update(childRel);
          hash.update('\0');
          if (entry.isSymbolicLink()) {
            hash.update(readlinkSync(childPath));
            hash.update('\0');
            try {
              const target = statSync(childPath);
              if (target.isDirectory()) {
                walk(childRel);
              } else if (target.isFile()) {
                hash.update(readFileSync(childPath));
              } else {
                throw new Error(`Unsupported uploader symlink target: ${childRel}`);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              hash.update('missing');
            }
          } else {
            hash.update(readFileSync(childPath));
          }
          hash.update('\0');
        }
      } finally {
        visiting.delete(real);
      }
    };
    walk('');
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Assert the wrangler uploader bundle was NOT modified between the pre-build snapshot and now.
 * A legitimate `vite build` never touches `node_modules/wrangler`, so the hash is stable across
 * the build. A build that overwrote the uploader — to run attacker code WITH the Cloudflare token
 * at the post-build remote migrate / deploy — changes it, and an unresolvable/unreadable binary
 * (either snapshot `undefined`) is a binary that cannot be verified: both FAIL CLOSED.
 */
export function assertWranglerUploaderUnchanged(
  before: string | undefined,
  after: string | undefined,
): { ok: boolean; reason?: string } {
  if (before === undefined || after === undefined) {
    return {
      ok: false,
      reason: `could not resolve or hash the Cloudflare uploader to verify it across the build — refusing to run a deploy binary that cannot be verified.`,
    };
  }
  if (before !== after) {
    return {
      ok: false,
      reason: `the build modified the Cloudflare uploader (its bundle hash changed across the build) — refusing to run it with your Cloudflare credentials.`,
    };
  }
  return { ok: true };
}

/**
 * True when a resource field's emitted value carries NO capability: `undefined`/`null`, an empty
 * array, an empty object, or a `{ bindings: [] }`. A clean `vite build` (root declaring none of
 * the whole-object-pinned fields) emits `unsafe` / `tail_consumers` / `streaming_tail_consumers`
 * ABSENT (verified against a real build); this also absorbs any normalizer default-fill
 * (`[]` / `{}` / `{ bindings: [] }`) so the whole-object pin never false-positives on an empty
 * shape while still catching a value that actually grants a capability.
 */
function isEmptyPassthroughValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return true;
    }
    if (keys.length === 1 && keys[0] === 'bindings') {
      const bindings = (value as Record<string, unknown>).bindings;
      return Array.isArray(bindings) && bindings.length === 0;
    }
  }
  return false;
}

/**
 * Reject an emitted `durable_objects` binding that targets ANOTHER worker (carrying a
 * {@link DURABLE_OBJECT_EXTERNAL_FIELDS} sub-field) unless the pre-build root declared the SAME
 * binding byte-for-byte. Void's own build only ever emits LOCAL DO bindings (`{name, class_name}`;
 * index.ts), so an external DO in the artifact is a build injection — a handle to a same-account
 * worker's Durable Objects the source never asked for. Emitted LOCAL DOs (no cross-script field)
 * always pass. A malformed emitted `durable_objects` fails closed (Void never emits one).
 */
function verifyNoInjectedExternalDurableObject(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
  try {
    emittedEntries = bindingEntriesForField('durable_objects', emitted);
  } catch {
    return {
      ok: false,
      reason: `generated config declares a malformed durable_objects binding — refusing to deploy a binding set that cannot be verified.`,
    };
  }
  const rootByName = new Map<string, Record<string, unknown>>();
  try {
    for (const { name, entry } of bindingEntriesForField('durable_objects', root)) {
      rootByName.set(name, entry);
    }
  } catch {
    // A malformed root records no pins, so any emitted EXTERNAL DO fails closed below.
    rootByName.clear();
  }
  for (const { name, entry } of emittedEntries) {
    if (!DURABLE_OBJECT_EXTERNAL_FIELDS.some((key) => entry[key] !== undefined)) {
      continue;
    }
    const rootEntry = rootByName.get(name);
    if (rootEntry === undefined || !deepEqual(entry, rootEntry)) {
      return {
        ok: false,
        reason: `generated config declares a durable_objects binding ${JSON.stringify(name)} bound to another worker's script that was not present before the build — refusing to deploy an external Durable Object the build injected.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reject an emitted `migrations` entry that carries a {@link DESTRUCTIVE_MIGRATION_KEYS} key unless
 * the pre-build root declared the SAME entry byte-for-byte. Void's build only ever emits migrations
 * with CREATION keys (its own DOs), so a destructive entry in the artifact is a build injection —
 * `wrangler deploy` runs the emitted migrations and would DELETE or MOVE production Durable Object
 * data. Emitted entries with only creation keys are NEVER inspected (Void's own migrations pass
 * untouched), and a user's own root-declared destructive migration (e.g. a legit rename) is pinned
 * and passes. This is the destructive-injection guard only — deriving Void's complete desired
 * migration set (full array pinning) is out of scope.
 */
function verifyNoInjectedDestructiveMigration(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  if (!Array.isArray(emitted)) {
    // Void emits `migrations` as an array; a non-array (or absent) value carries no destructive
    // entry to check here, and full migration-array pinning is out of scope.
    return { ok: true };
  }
  const rootEntries = Array.isArray(root) ? root : [];
  for (const entry of emitted) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!DESTRUCTIVE_MIGRATION_KEYS.some((key) => record[key] !== undefined)) {
      continue;
    }
    if (!rootEntries.some((rootEntry) => deepEqual(record, rootEntry))) {
      const tag = typeof record.tag === 'string' ? ` ${JSON.stringify(record.tag)}` : '';
      return {
        ok: false,
        reason: `generated config declares a destructive Durable Object migration${tag} (deleting, renaming, or transferring classes) that was not present before the build — refusing to deploy a migration the build added that would delete or move Durable Object data.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Minimal JSON-safe structural equality: primitives by `===`, arrays element-wise, plain objects
 * key-for-key (order-insensitive). Used to compare a pinned pre-build pass-through binding entry's
 * values against the emitted artifact's, so a build that RETARGETS a binding (rewrites a
 * service/namespace/type the user wrote in root) is caught while a normalizer-added default
 * sub-field is ignored. No cyclic/`undefined`/class support needed — wrangler config is JSON.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]),
  );
}

/**
 * Every queue NAME the emitted artifact binds — `queues.producers[].queue` +
 * `queues.consumers[].queue`. Non-throwing: a wrong-shaped `queues` field or an entry with no
 * readable `queue` string contributes no name (an unnamed queue binds nothing), so only real,
 * NAMED queue bindings are asserted against the desired set.
 */
function collectEmittedQueueNames(value: unknown): Array<string> {
  const names: Array<string> = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return names;
  }
  for (const group of ['producers', 'consumers'] as const) {
    const list = (value as Record<string, unknown>)[group];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const name = readD1EntryString(entry, 'queue');
      if (name !== undefined) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The queue NAMES the emitted artifact binds in ONE group (`producers` or `consumers`), as a Set.
 * Read defensively — a wrong-shaped `queues` field, a missing group, or an entry with no readable
 * `queue` string contributes no name — so a missing/empty group yields an EMPTY set. Used to assert
 * every DESIRED queue survives in BOTH groups: `mergeBindings` (index.ts) emits each desired queue as
 * both a producer AND a consumer, so per-group presence is required — {@link collectEmittedQueueNames}
 * merges the two groups and cannot tell that a queue lost one of its two sides.
 */
function collectEmittedQueueGroupNames(
  value: unknown,
  group: 'producers' | 'consumers',
): Set<string> {
  const names = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return names;
  }
  const list = (value as Record<string, unknown>)[group];
  if (!Array.isArray(list)) {
    return names;
  }
  for (const entry of list) {
    const name = readD1EntryString(entry, 'queue');
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/** The CF Vite plugin's deploy-config redirect that a bare `wrangler deploy` follows. */
function deployPointerPath(root: string): string {
  return join(root, '.wrangler', 'deploy', 'config.json');
}

/**
 * Cloudflare credential env vars that must not reach untrusted project code. This includes
 * Wrangler 4.131's full authentication set, verified against
 * `wrangler-dist/cli.js`. It covers every env var wrangler reads to authenticate —
 * the API-client auth inputs (`apiToken`/`apiKey`/`apiEmail`/`userServiceKey`) plus
 * the `getEnvironmentVariableFactory` auth tokens — each canonical name AND its
 * deprecated `CF_*` alias:
 *   - API token:            `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN`
 *   - global auth key:      `CLOUDFLARE_API_KEY` / `CF_API_KEY`
 *   - global auth email:    `CLOUDFLARE_EMAIL` / `CF_EMAIL`
 *   - user service key:     `CLOUDFLARE_API_USER_SERVICE_KEY`
 *   - CF authorization tok: `WRANGLER_CF_AUTHORIZATION_TOKEN`
 *   - R2 SQL auth token:    `WRANGLER_R2_SQL_AUTH_TOKEN` (a Bearer credential wrangler
 *     reads via `getEnvironmentVariableFactory`, falling back to `CLOUDFLARE_API_TOKEN`)
 *   - Access service token: `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`
 *   - Readiness user JWT:   `CF_ACCESS_TOKEN` (Void-only; Wrangler never receives it)
 * Scrubbed from EVERY child that runs untrusted project code — the env-schema probes, the
 * `vite build`, and `drizzle-kit generate` (which loads the user's schema). None of them
 * authenticates against Cloudflare, so a leaking `env.ts` / build plugin / schema module can
 * never read a real credential the parent holds. NOT scrubbed from the wrangler runner's env
 * (`createDeployWranglerRunner`), where `whoami` / `d1 migrations apply` / `deploy` need them.
 * (`provisionEnv` already scrubs Void's own `CF_ACCESS_CLIENT_ID/SECRET` pair + the
 * account-id selector; this adds the wrangler-account credentials it does not.)
 */
/**
 * Delete every {@link WRANGLER_AUTH_CREDENTIAL_ENV_VARS} entry from `env` IN PLACE and
 * return it, for a child that executes UNTRUSTED project code and needs no Cloudflare
 * credential of its own.
 *
 * The case-aware delete lives in the provision module, which ONLY the Cloudflare fork
 * loads (a managed deploy must not pay `proper-lockfile`'s import-time side effects). One
 * caller — `runDrizzleKitGenerate`, via the shared schema-drift check — also runs on the
 * MANAGED path, where that module is legitimately absent, so read the memoized handle
 * directly instead of {@link requireProvisionModule} (which throws when the fork never ran)
 * and fall back to the exact-case delete. That fallback IS the whole rule off win32 (POSIX
 * env keys are case-sensitive); the case-insensitive win32 sweep only matters for the
 * Cloudflare fork, and by the time either call site runs there the module is always loaded.
 */
function scrubWranglerAuthCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const deleteVar =
    loadedProvisionModule?.deleteEnvVarCaseAware ??
    ((target: NodeJS.ProcessEnv, name: string): void => {
      delete target[name];
    });
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    deleteVar(env, name);
  }
  // These are not Wrangler credentials, but native Cloudflare builds do not
  // need either one: DATABASE_URL is consumed only by the parent-side
  // provision/migration steps, and VOID_TOKEN belongs to the managed target.
  deleteVar(env, 'DATABASE_URL');
  deleteVar(env, 'VOID_TOKEN');
  return env;
}

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
  const env = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Match the Cloudflare deploy build's dotenv boundary. Besides keeping a
  // schema conditioned on this internal marker consistent with the build,
  // this prevents an ambient case variant from shadowing the pinned value on
  // Windows.
  requireProvisionModule().deleteEnvVarCaseAware(env, CLOUDFLARE_DEPLOY_BUILD_ENV);
  env[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  requireProvisionModule().deleteEnvVarCaseAware(env, 'NODE_ENV');
  env.NODE_ENV = 'production';
  return env;
}

/**
 * Default {@link CloudflareDeployDeps.resolveSchemaFacts} seam: derive the
 * env-INSENSITIVE schema facts (server and required key names) in an ISOLATED SUBPROCESS ({@link
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

function resolveGeneratedDeployConfigPathDefault(root: string): string {
  const pointerPath = deployPointerPath(root);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { configPath?: unknown };
  if (typeof pointer.configPath !== 'string' || pointer.configPath.length === 0) {
    throw new Error(`Generated Cloudflare deploy pointer ${pointerPath} has no configPath.`);
  }
  return resolve(dirname(pointerPath), pointer.configPath);
}

function readGeneratedDeployConfig(root: string): {
  path: string;
  config: Record<string, unknown>;
} {
  const redirectedPath = resolveGeneratedDeployConfigPathDefault(root);
  try {
    return { path: redirectedPath, config: readGeneratedWranglerConfigFile(redirectedPath) };
  } catch {
    throw new Error(
      `Generated Cloudflare deploy config ${redirectedPath} is missing or invalid JSON/JSONC.`,
    );
  }
}

/** Older project plugins can repeat root flags; normalize only the generated artifact. */
function deduplicateGeneratedCompatibilityFlags(configPath: string, rootConfigPath: string): void {
  if (resolve(configPath) === resolve(rootConfigPath) || !existsSync(configPath)) {
    return;
  }
  const config = parseRootWranglerConfig(configPath);
  const flags = config.compatibility_flags;
  if (!Array.isArray(flags) || !flags.every((flag): flag is string => typeof flag === 'string')) {
    return;
  }
  const uniqueFlags = [...new Set(flags)];
  if (uniqueFlags.length !== flags.length) {
    config.compatibility_flags = uniqueFlags;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * Check whether Void contributes worker-side routing rules.
 */
function hasConfiguredVoidWorkerRoutingRules(routing: RoutingConfig | undefined): boolean {
  return (
    routing !== undefined &&
    [routing.redirects, routing.rewrites, routing.fallbacks, routing.headers].some(
      (rules) => rules !== undefined && Object.keys(rules).length > 0,
    )
  );
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
 * mismatch. When a `bindingIdentitySnapshot` is given we therefore assert, in TWO directions,
 * that the generated artifact's id-bearing bindings (D1 database_id / KV id / R2 bucket_name /
 * Hyperdrive id) equal the identities PINNED before the build (the in-memory snapshot the
 * drift-check / provision resolved) — NOT a post-build re-read of the root config, so a build
 * that consistently rewrote BOTH the root config and this artifact is still caught:
 *   (a) with `desired`, every DESIRED binding must still be present with its pinned id — catches a
 *       binding the build DROPPED or whose id it rewrote; and
 *   (b) COMPLETENESS — every id-bearing binding the artifact declares must be one the snapshot
 *       pinned, with the pinned id — catches a binding the build ADDED (absent from the snapshot)
 *       or a pre-existing NON-desired binding whose id it rewrote, either of which the CF plugin
 *       would otherwise merge verbatim into the artifact and `wrangler deploy` would bind.
 * Only these four id-bearing kinds are inspected; every other binding the build legitimately
 * emits (ai / queues / durable_objects / vars / …) passes through untouched. This makes the id
 * defense symmetric with the `account_id` check above, which already compares against the
 * in-memory pinned account. Returns `{ ok:false, reason }` on any mismatch — or when the config
 * is missing/unreadable — so the caller fails closed.
 */
export function verifyGeneratedDeployConfig(
  root: string,
  expected: {
    accountId: string;
    workerName: string;
    desired?: DesiredResourceSet;
    bindingIdentitySnapshot?: BindingIdentitySnapshot;
    /**
     * Per-assert-field binding ENTRY pin taken pre-build ({@link snapshotPassthroughIdentities}) —
     * field → (bindingName → root entry). Drives the pass-through assertion: an emitted entry in a
     * field Void never emits whose binding was not pinned pre-build is a build-injected binding,
     * and one whose pinned target keys were rewritten is a build-retargeted binding.
     */
    passthroughIdentitySnapshot?: Map<string, Map<string, Record<string, unknown>>>;
    /**
     * Raw pre-build root values ({@link snapshotPassthroughRawFields}) for the fields the ENTRY
     * pin cannot cover: `unsafe` / `tail_consumers` / `streaming_tail_consumers`
     * (whole-object-pinned), `durable_objects` (external-DO check), and `ai` (binding pin). An
     * emitted value that diverges from its root pin — a whole-object field added/removed/rewritten,
     * an external DO absent from root, or an `ai` binding that is neither the root's nor Void's own
     * (and only when the source uses AI) — fails closed.
     */
    passthroughRawFields?: Map<string, unknown>;
    /**
     * Whether the pre-build inference found Workers AI use in the source (the SAME `needsAI`
     * signal `shouldBindWorkersAi` gates on in index.ts). Authorizes Void's emitted AI binding
     * (default `AI`, or `aiBindingName`) when the root config declares none: only an AI-using app
     * legitimately receives one, so a build that injects it into a non-AI app (billable inference
     * the source never asked for) fails closed.
     */
    needsAI?: boolean;
    /** Custom `inference.bindings.ai` name authorized for Void's emitted AI binding. */
    aiBindingName?: string;
    /**
     * Auth-enabled Cloudflare builds must emit `secrets.required` with
     * BETTER_AUTH_SECRET so Wrangler inherits the persistent remote value into
     * the uploaded Worker version instead of dropping it during replacement.
     */
    authEnabled?: boolean;
    /** Additional Worker secret names the generated version must inherit. */
    requiredSecretNames?: Array<string>;
    /**
     * The exact `containers` set Void's build emits, reconstructed PRE-BUILD
     * ({@link reconstructExpectedContainers}) from the root-declared containers plus — when the
     * source needs the sandbox — Void's own sandbox container. A bare `wrangler deploy` PROVISIONS a
     * container application from the emitted array (billable, runs the image), so an emitted
     * container absent from this set is one the build INJECTED, an expected container missing from
     * the emitted array is one it DROPPED, and one present but not byte-identical is one it
     * RETARGETED (e.g. a rewritten `image` pointing at an attacker's).
     */
    expectedContainers?: Array<Record<string, unknown>>;
    /** Exact pre-build Durable Object bindings, including Void's sandbox and live additions. */
    expectedDurableObjectBindings?: Array<Record<string, unknown>>;
    /** Exact pre-build migration sequence, including Void's sandbox and live additions. */
    expectedMigrations?: Array<Record<string, unknown>>;
    /**
     * The exact cron trigger schedules Void's build emits into `triggers.crons`, reconstructed
     * PRE-BUILD from the SAME `scanJobsSync` scan index.ts derives them from
     * ({@link computeDesiredCloudflareResources}). A bare `wrangler deploy` reading
     * `dist/ssr/wrangler.json` INSTALLS the worker's Cron Triggers from `triggers.crons`, so an
     * emitted schedule absent from this multiset is one the build INJECTED (attacker code runs on a
     * billable schedule) and an expected schedule missing from the emitted array is one it DROPPED
     * (or, paired with an injected replacement, RETARGETED).
     */
    expectedCrons?: Array<string>;
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
    generated = readGeneratedWranglerConfigFile(redirectedPath);
  } catch {
    return {
      ok: false,
      reason: `generated wrangler config ${redirectedPath} is not valid JSON/JSONC.`,
    };
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
  const expectedRequiredSecrets = new Set(expected.requiredSecretNames ?? []);
  if (expected.authEnabled) {
    expectedRequiredSecrets.add(BETTER_AUTH_SECRET_NAME);
  }
  if (expectedRequiredSecrets.size > 0) {
    const secrets = generated.secrets;
    const required =
      typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets)
        ? (secrets as Record<string, unknown>).required
        : undefined;
    if (
      !Array.isArray(required) ||
      !required.every((name): name is string => typeof name === 'string') ||
      [...expectedRequiredSecrets].some((name) => !required.includes(name))
    ) {
      return {
        ok: false,
        reason:
          `generated config must include ${[...expectedRequiredSecrets].join(', ')} in ` +
          '`secrets.required` so wrangler inherits the persistent secrets during upload.',
      };
    }
  }
  // Binding-identity check: the generated artifact's id-bearing bindings must be the SAME ones
  // (by id) as were PINNED before the build (the in-memory snapshot). A flattened named-env /
  // alternate config — or a build that rewrote/added an id in BOTH the root config and this
  // artifact — keeps account+name but swaps the binding set, caught here against the snapshot.
  if (expected.bindingIdentitySnapshot) {
    const snapshot = expected.bindingIdentitySnapshot;
    // (a) Every DESIRED binding must still be present with its pinned id — catches a binding the
    // build DROPPED (the completeness loop below, which only walks what the artifact DECLARES,
    // cannot see an omission) or whose id it rewrote.
    if (expected.desired) {
      for (const { kind, binding } of desiredIdentityBindings(expected.desired)) {
        const { field, idField } = DEPLOY_BINDING_IDENTITY_FIELDS[kind];
        const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
        // A binding with no pinned id was never provisioned with a real one (the drift check's
        // job); here we only assert the generated artifact did not DIVERGE from the pre-build pin.
        if (pinnedId === undefined) {
          continue;
        }
        const generatedId = readStoredResourceName(generated, field, binding, idField);
        if (generatedId === undefined) {
          return {
            ok: false,
            reason: `generated config is missing the ${field} binding ${JSON.stringify(binding)} (pinned identity ${JSON.stringify(pinnedId)}) — a named environment or alternate config flattened a different binding set.`,
          };
        }
        if (generatedId !== pinnedId) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(generatedId)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a flattened/alternate or tampered binding set.`,
          };
        }
      }
    }
    // (b) COMPLETENESS — every id-bearing binding the artifact DECLARES must be one the snapshot
    // pinned (by binding name) AND carry the pinned id. The desired loop above only inspects the
    // desired set, so a binding the build ADDED to the root config (absent from the snapshot) or a
    // pre-existing NON-desired binding whose id it rewrote would otherwise flow into the artifact
    // and get bound by `wrangler deploy`. Scoped to the four id-bearing kinds only — every other
    // binding the build emits (ai / queues / durable_objects / vars / …) is neither inspected nor
    // rejected. The pin is the pre-build snapshot of the SAME root config the CF plugin merges, so
    // a legitimately emitted binding's id equals what was captured; only an added / rewritten one
    // diverges.
    for (const { field, binding, id } of collectConfigBindingIdentities(generated)) {
      const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
      if (pinnedId === undefined) {
        return {
          ok: false,
          reason: `generated config declares a ${field} binding ${JSON.stringify(binding)} that was not present before the build — refusing to deploy an id-bearing binding the build injected.`,
        };
      }
      if (id !== pinnedId) {
        return {
          ok: false,
          reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(id)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a rewritten binding set.`,
        };
      }
    }
    // (c) Reverse-presence — the desired loop (a) inspects only the DESIRED bindings and the
    // completeness loop (b) walks only what the artifact DECLARES, so neither sees a NON-desired,
    // manually-declared root id-bearing binding (e.g. a hand-added `EXTRA_DB`) the build DROPPED: it
    // is absent from `desired`, and (b) cannot iterate an omission. Walk the PINNED snapshot instead —
    // every pinned `<field>:<binding>` must still appear among the emitted id-bearing bindings (read
    // the SAME way (b) reads them). A field the build removed entirely leaves every pinned binding in
    // it missing. This is the exact mirror of the pass-through reverse-presence loop (A1) below and is
    // FP-safe on the same reasoning: a legitimate CF-plugin build spreads the root config, so no
    // pinned id-binding is ever dropped; `bindingIdentitySnapshot` holds only bindings that had a real
    // id pre-build, so a placeholder/absent id is never asserted here.
    const emittedIdentityKeys = new Set<string>();
    for (const { field, binding } of collectConfigBindingIdentities(generated)) {
      emittedIdentityKeys.add(bindingIdentityKey(field, binding));
    }
    for (const key of snapshot.keys()) {
      if (!emittedIdentityKeys.has(key)) {
        const separator = key.indexOf(':');
        const field = key.slice(0, separator);
        const binding = key.slice(separator + 1);
        return {
          ok: false,
          reason: `generated config no longer declares the ${field} binding ${JSON.stringify(binding)} that was present before the build — refusing to deploy a build that dropped an id-bearing binding the root config declared.`,
        };
      }
    }
  }
  // (A) Pass-through assert-set — every entry the artifact declares in a resource field Void's own
  // build never emits ({@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS}, derived from the wrangler binding
  // registry) must have been present in the pre-build root snapshot, matched by its wrangler-shape
  // identity key, AND be byte-identical to the pinned root entry. Two failures fail closed:
  //   • the binding name was NOT pinned pre-build → a binding the build INJECTED; and
  //   • the emitted entry differs from the pinned root entry → a binding the build REWROTE
  //     (kept the name but changed the service/namespace/type it points at, or added a sub-field).
  // Compare the WHOLE entry (exact equality): a real `vite build` adds NOTHING to a PRESENT
  // pass-through entry — services/vectorize/workflows/mtls_certificates/send_email/ratelimits/
  // dispatch_namespaces all emit byte-identical to root — so any added/removed/rewritten sub-field
  // is the build tampering with the binding's target. Fields NOT in the assert-set are deliberately
  // NOT asserted here (fail OPEN): a resource field wrangler does not yet know about must never
  // false-positive a legitimate build. `unsafe` stays in the assert-set (for the drift invariant)
  // but is routed to the whole-object pin below — its `.metadata`/`.capnp` are never entry-iterated.
  if (expected.passthroughIdentitySnapshot) {
    const passthrough = expected.passthroughIdentitySnapshot;
    for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || generated[field] === undefined) {
        continue;
      }
      let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
      try {
        emittedEntries = bindingEntriesForField(field, generated[field]);
      } catch {
        return {
          ok: false,
          reason: `generated config declares a malformed ${field} binding — refusing to deploy a binding set that cannot be verified.`,
        };
      }
      const pinned = passthrough.get(field) ?? new Map<string, Record<string, unknown>>();
      for (const { name, entry } of emittedEntries) {
        const pinnedEntry = pinned.get(name);
        if (pinnedEntry === undefined) {
          return {
            ok: false,
            reason: `generated config declares a ${field} binding ${JSON.stringify(name)} that was not present before the build — refusing to deploy a ${field} binding the build injected.`,
          };
        }
        if (!deepEqual(entry, pinnedEntry)) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(name)} differs from the pre-build config — refusing to deploy a ${field} binding the build rewrote.`,
          };
        }
      }
    }
    // (A1) Reverse-presence — the forward loop above only walks EMITTED entries, so it cannot see a
    // root-declared pass-through binding the build DROPPED (removing a `services` / `mtls_certificates`
    // / … binding the source declared silently strips a capability). Walk the PINNED entries instead:
    // every pinned binding NAME must still appear in the emitted entries for its field. A field
    // ABSENT from the emitted config means every pinned name in it is missing. Whole-object-pinned
    // fields are skipped — their SYMMETRIC raw pin already rejects a removed value. FP-safe: a
    // legitimate CF-plugin build spreads the root config, so no pinned pass-through binding is ever
    // dropped; only a build that omits one to strip what the source declared is caught here.
    for (const [field, pinnedEntries] of passthrough) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || pinnedEntries.size === 0) {
        continue;
      }
      const emittedNames = new Set<string>();
      if (generated[field] !== undefined) {
        try {
          for (const { name } of bindingEntriesForField(field, generated[field])) {
            emittedNames.add(name);
          }
        } catch {
          // A malformed emitted field is already rejected by the forward loop; treat it as carrying
          // no names so any pinned name is reported missing here too (fail closed).
        }
      }
      for (const name of pinnedEntries.keys()) {
        if (!emittedNames.has(name)) {
          return {
            ok: false,
            reason: `generated config no longer declares the ${field} binding ${JSON.stringify(name)} that was present before the build — refusing to deploy a build that dropped a ${field} binding the source declared.`,
          };
        }
      }
    }
  }
  // (A2) Whole-object + targeted pins for the fields the per-binding ENTRY pin cannot cover, each
  // compared against the raw pre-build root value ({@link snapshotPassthroughRawFields}):
  //   • `unsafe` / `tail_consumers` / `streaming_tail_consumers` — the emitted value must be
  //     byte-identical to the root's. The empty check is SYMMETRIC: an emitted empty value passes
  //     ONLY when the root value is ALSO empty (the clean-build shape / a normalizer default-fill).
  //     A root that DECLARED a non-empty value emitted back EMPTY is a REMOVAL — clearing
  //     `tail_consumers` silently disables the source's audit/log forwarding — so it is rejected
  //     like any other rewrite. `unsafe.metadata` overwrites the WHOLE uploaded bindings array at
  //     upload, and `tail_consumers`/`streaming_tail_consumers` forward every log/request — so a
  //     build injecting, rewriting, OR removing one changes exfil/audit the source declared.
  //   • `routes` / `route` / `workers_dev` / `preview_urls` — the worker's traffic attachment.
  //     Void emits none, so undeclared → absent → both-empty → pass; a build-injected `routes`
  //     entry (attaching the worker to a hostname the account controls) or a flipped
  //     `workers_dev`/`preview_urls` fails the deepEqual against the absent/declared root value.
  //   • `addresses` — the worker's inbound-mail attachment. Same pin, minus the both-empty pass:
  //     `[]` is loaded (it deletes every owned routing rule), so an emitted `[]` passes only
  //     when the root declared exactly `[]`.
  //   • `durable_objects` — an emitted binding carrying a cross-script field targets ANOTHER
  //     worker's DOs; Void's own DOs are always LOCAL, so it must match a root binding.
  //   • `ai` — when the root declared its own ai binding it must SURVIVE byte-identical (a build
  //     that REMOVED or rewrote it is rejected); otherwise the emitted binding must be ABSENT or —
  //     ONLY when the source's pre-build inference says the app uses Workers AI — Void's
  //     configured Workers AI binding. An injected AI binding on an app that does not use AI would
  //     incur account-billed inference from build-injected worker code.
  //   • `migrations` — an emitted Durable Object migration carrying a DESTRUCTIVE key (deleting,
  //     renaming, or transferring classes) must match a root-declared migration byte-for-byte;
  //     Void emits only creation-key migrations, so a destructive one is a build injection that
  //     `wrangler deploy` would run against production Durable Object data.
  if (expected.passthroughRawFields) {
    const raw = expected.passthroughRawFields;
    for (const field of DEPLOY_WHOLE_OBJECT_PINNED_FIELDS) {
      const emitted = generated[field];
      const rootValue = raw.get(field);
      // Both-empty is the only case an empty emitted value passes: a root that declared a
      // non-empty value emitted back empty REMOVES a control the source configured.
      // `addresses: []` is NOT empty to wrangler — it plans the deletion of every rule this
      // worker owns (wrangler returns early only on `undefined`, and never default-fills the
      // key) — so it gets no both-empty pass: an emitted `[]` must equal a root-declared `[]`.
      if (
        field !== 'addresses' &&
        isEmptyPassthroughValue(emitted) &&
        isEmptyPassthroughValue(rootValue)
      ) {
        continue;
      }
      if (!deepEqual(emitted, rootValue)) {
        return {
          ok: false,
          reason: `generated config ${field} value does not match the pre-build config — refusing to deploy a ${field} value the build added, removed, or rewrote.`,
        };
      }
    }
    const externalDo = verifyNoInjectedExternalDurableObject(
      generated.durable_objects,
      raw.get('durable_objects'),
    );
    if (!externalDo.ok) {
      return externalDo;
    }
    // Read `rootAi` FIRST (not gated on `emittedAi !== undefined`) so a root ai binding the build
    // REMOVED — emitted ai absent — is rejected too, not only a rewrite.
    const emittedAi = generated.ai;
    const rootAi = raw.get('ai');
    if (rootAi !== undefined) {
      // The root declared its own `ai` binding — the emitted one must equal it EXACTLY, so a build
      // can neither rewrite a custom root ai binding down to the default `{binding:'AI'}` nor drop
      // it (`deepEqual(undefined, rootAi)` is false → a removed root ai fails closed here).
      if (!deepEqual(emittedAi, rootAi)) {
        return {
          ok: false,
          reason: `generated config ai binding does not match the pre-build root ai binding — refusing to deploy an ai binding the build removed or rewrote.`,
        };
      }
    } else if (emittedAi !== undefined) {
      // No root ai binding: Void emits the configured binding name (default `AI`) ONLY when
      // pre-build inference says the source uses Workers AI. Anything else is build-injected.
      const expectedAi = { binding: expected.aiBindingName ?? DEFAULT_VOID_AI_BINDING };
      if (!(expected.needsAI === true && deepEqual(emittedAi, expectedAi))) {
        return {
          ok: false,
          reason: `generated config declares an ai binding the build injected — the pre-build inference found no Workers AI use in the source and the root config declares no ai binding.`,
        };
      }
    }
    // Reject a build-injected DESTRUCTIVE Durable Object migration. Only emitted migration entries
    // carrying a destructive key are checked, and each must match a root-declared migration
    // byte-for-byte, so Void's creation-only migrations and a user's own root-declared destructive
    // migration both pass — only an injected one absent from root is rejected.
    const destructiveMigration = verifyNoInjectedDestructiveMigration(
      generated.migrations,
      raw.get('migrations'),
    );
    if (!destructiveMigration.ok) {
      return destructiveMigration;
    }
  }
  if (expected.expectedDurableObjectBindings) {
    let emittedBindings: Array<Record<string, unknown>>;
    try {
      emittedBindings = bindingEntriesForField('durable_objects', generated.durable_objects).map(
        ({ entry }) => entry,
      );
    } catch {
      return {
        ok: false,
        reason: 'generated config durable_objects bindings could not be verified.',
      };
    }
    const byName = (left: Record<string, unknown>, right: Record<string, unknown>) =>
      String(left.name).localeCompare(String(right.name));
    if (
      !deepEqual(
        [...emittedBindings].sort(byName),
        [...expected.expectedDurableObjectBindings].sort(byName),
      )
    ) {
      return {
        ok: false,
        reason:
          'generated config durable_objects bindings differ from the pre-build binding set — refusing to deploy a binding the build added, removed, or retargeted.',
      };
    }
  }
  if (expected.expectedMigrations) {
    if (generated.migrations !== undefined && !Array.isArray(generated.migrations)) {
      return { ok: false, reason: 'generated config migrations could not be verified.' };
    }
    const emittedMigrations = Array.isArray(generated.migrations) ? generated.migrations : [];
    if (!deepEqual(emittedMigrations, expected.expectedMigrations)) {
      return {
        ok: false,
        reason:
          'generated config migrations differ from the pre-build migration sequence — refusing to deploy a migration the build added, removed, or retargeted.',
      };
    }
  }
  // (C) Containers — pin the emitted `containers` array against the set Void's build emits,
  // reconstructed PRE-BUILD ({@link reconstructExpectedContainers}): root-declared containers pass
  // through verbatim, plus Void's own sandbox container when the source needs it. A bare `wrangler
  // deploy` PROVISIONS a container application from this array — billable, and it runs the image's
  // code — so a build that INJECTS a container (an attacker image on an app that declared none),
  // DROPS the sandbox container, or RETARGETS one (rewrites its `image`/`instance_type`/… to an
  // attacker's) must fail closed. Compared as a set keyed by `class_name` — the identity
  // `mergeBindings` itself dedups on: every emitted container's class must be expected AND
  // byte-identical, and every expected class must still be emitted. `generated.containers` is read
  // defensively (absent/non-array → none), and absent-vs-`[]` is treated as both-empty so a clean
  // no-sandbox build (no root containers, Void adds none, emitted none) passes. Containers with no
  // `class_name` are not a shape Void or a buildable root config produce; they are compared as a
  // deepEqual multiset so a verbatim root passthrough still passes while an injected/dropped one
  // fails closed.
  if (expected.expectedContainers) {
    const emittedContainers: Array<unknown> = Array.isArray(generated.containers)
      ? generated.containers
      : [];
    const expectedContainers = expected.expectedContainers;
    if (emittedContainers.length !== 0 || expectedContainers.length !== 0) {
      const expectedByClass = new Map<string, Record<string, unknown>>();
      const expectedNoClass: Array<unknown> = [];
      for (const container of expectedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          expectedNoClass.push(container);
        } else {
          expectedByClass.set(className, container);
        }
      }
      const emittedByClass = new Map<string, unknown>();
      const emittedNoClass: Array<unknown> = [];
      for (const container of emittedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          emittedNoClass.push(container);
        } else {
          emittedByClass.set(className, container);
        }
      }
      // Injected / retargeted — every emitted container must be expected AND byte-identical.
      for (const [className, container] of emittedByClass) {
        const expectedContainer = expectedByClass.get(className);
        if (expectedContainer === undefined) {
          return {
            ok: false,
            reason: `generated config declares a container application ${JSON.stringify(className)} that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        if (
          !deepEqual(
            normalizeContainerImagePaths(container, dirname(redirectedPath)),
            normalizeContainerImagePaths(expectedContainer, root),
          )
        ) {
          return {
            ok: false,
            reason: `generated config container application ${JSON.stringify(className)} does not match the pre-build config — refusing to deploy a container application the build retargeted.`,
          };
        }
      }
      // Dropped — every expected container must still be emitted.
      for (const className of expectedByClass.keys()) {
        if (!emittedByClass.has(className)) {
          return {
            ok: false,
            reason: `generated config no longer declares the container application ${JSON.stringify(className)} that Void derived from source — refusing to deploy a build that dropped a container application.`,
          };
        }
      }
      // Class-less containers — deepEqual multiset (never a Void-emitted shape).
      for (const emitted of emittedNoClass) {
        const matchIndex = expectedNoClass.findIndex((candidate) => deepEqual(emitted, candidate));
        if (matchIndex === -1) {
          return {
            ok: false,
            reason: `generated config declares a container application that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        expectedNoClass.splice(matchIndex, 1);
      }
      if (expectedNoClass.length > 0) {
        return {
          ok: false,
          reason: `generated config no longer declares a container application that was present before the build — refusing to deploy a build that dropped a container application.`,
        };
      }
    }
  }
  // (B) Queues ⊆ desired — every queue the artifact binds (producers/consumers) must be one Void
  // desired from source (`scanQueuesSync`, the SAME scan the build binds from), so a legitimate
  // build always satisfies emitted ⊆ desired. A queue NAME the artifact binds that is not in the
  // desired set is a queue binding the build injected — fail closed.
  if (expected.desired) {
    const desiredQueues = new Set(expected.desired.queues);
    for (const name of collectEmittedQueueNames(generated.queues)) {
      if (!desiredQueues.has(name)) {
        return {
          ok: false,
          reason: `generated config declares a queue binding ${JSON.stringify(name)} that Void did not derive from source — refusing to deploy a queue binding the build injected.`,
        };
      }
    }
    // (B1) desired ⊆ emitted, PER GROUP — the emitted ⊆ desired check above rejects an INJECTED
    // queue but waves through a DROPPED one: an absent/empty `queues` field, or one retaining only
    // the producer OR only the consumer, would deploy a worker that loses message processing or
    // leaves a `QUEUE_*` binding undefined. `mergeBindings` (index.ts) emits EVERY desired queue as
    // BOTH a producer and a consumer (both groups mapped from the SAME scanned array), so requiring
    // each desired queue name in both emitted groups is FP-safe. Read each group defensively (a
    // missing/empty/wrong-shaped `queues` field yields empty sets → any desired queue is reported
    // missing → reject); per-group presence is why this cannot reuse the merged reader above.
    const emittedProducers = collectEmittedQueueGroupNames(generated.queues, 'producers');
    const emittedConsumers = collectEmittedQueueGroupNames(generated.queues, 'consumers');
    for (const name of expected.desired.queues) {
      if (!emittedProducers.has(name) || !emittedConsumers.has(name)) {
        return {
          ok: false,
          reason: `generated config no longer binds the queue ${JSON.stringify(name)} as both a producer and a consumer that Void derived from source — refusing to deploy a build that dropped a queue binding the source declared.`,
        };
      }
    }
  }
  // (D) Cron Triggers — pin the emitted `triggers.crons` schedules against the set Void's build
  // emits, reconstructed PRE-BUILD from the SAME `scanJobsSync` scan index.ts derives them from
  // (`scanJobsSync(root, paths.cronsDir).flatMap((job) => job.crons)`). A bare `wrangler deploy`
  // reading `dist/ssr/wrangler.json` INSTALLS the worker's Cron Triggers from this array — a
  // schedule the build INJECTED runs attacker code on a billable schedule, and one it DROPPED (or
  // RETARGETED, caught as a drop of the old string plus an injection of the new one) silently
  // changes the worker's scheduled behavior. Compared as an order-independent, count-aware multiset
  // of schedule strings. `generated.triggers` is read DEFENSIVELY: only an object with an array
  // `crons` yields emitted schedules — anything else (absent, a bare `{}` the CF plugin
  // materializes for a no-cron app, a non-array `crons`) yields none, so a no-cron app (expected
  // empty, emitted none) passes symmetric-empty. A non-string emitted element is never a shape Void
  // derives, so it fails the expected lookup and is rejected as injected.
  if (expected.expectedCrons) {
    const triggers = generated.triggers;
    const emittedCrons: Array<unknown> =
      typeof triggers === 'object' &&
      triggers !== null &&
      Array.isArray((triggers as Record<string, unknown>).crons)
        ? ((triggers as Record<string, unknown>).crons as Array<unknown>)
        : [];
    const expectedCronCounts = new Map<string, number>();
    for (const schedule of expected.expectedCrons) {
      expectedCronCounts.set(schedule, (expectedCronCounts.get(schedule) ?? 0) + 1);
    }
    // Injected / retargeted — every emitted schedule must be one the source derived, with a
    // remaining count; anything else is a schedule the build injected.
    for (const schedule of emittedCrons) {
      const remaining = typeof schedule === 'string' ? (expectedCronCounts.get(schedule) ?? 0) : 0;
      if (typeof schedule !== 'string' || remaining <= 0) {
        return {
          ok: false,
          reason: `generated config declares a cron trigger schedule ${JSON.stringify(schedule)} that Void did not derive from source — refusing to deploy a schedule the build injected.`,
        };
      }
      expectedCronCounts.set(schedule, remaining - 1);
    }
    // Dropped — every expected schedule must still be emitted; any leftover count is a schedule the
    // build dropped (e.g. the old side of a retarget).
    for (const [schedule, remaining] of expectedCronCounts) {
      if (remaining > 0) {
        return {
          ok: false,
          reason: `generated config no longer installs the cron trigger schedule ${JSON.stringify(schedule)} that Void derived from source — refusing to deploy a build that dropped a cron trigger.`,
        };
      }
    }
  }
  return { ok: true };
}

/** Result of one orchestrator-owned wrangler invocation (whoami/migrate/deploy). */
export type DeployWranglerRunResult = CloudflareCommandResult;
export type DeployWranglerRun = (
  operation: CloudflareOperation,
  opts: { capture: boolean; input?: string; env?: Record<string, string> },
) => DeployWranglerRunResult | Promise<DeployWranglerRunResult>;

/**
 * Injectable seams for {@link runCloudflareDeploy}, so the whole orchestration
 * is unit-testable with NO real wrangler / network / Cloudflare account — the
 * same pattern the provisioner (`cli/provision.ts`) and the self-host secret
 * units (`cli/env-validation.ts`) use.
 */
export interface CloudflareDeployDeps {
  /** Interactive migration choice; persisted in void.config.ts before provisioning. */
  confirmIsrSetup?: (message: string) => Promise<boolean>;
  readExistingWorker?: typeof readExistingCloudflareWorker;
  /** Fail closed on a pending existing-Worker Durable Object class migration. */
  assertDurableObjectLifecycle?: typeof assertCloudflareDurableObjectLifecycleSupported;
  /** wrangler runner for the orchestrator's own whoami/migrate/deploy calls. */
  runWrangler?: DeployWranglerRun;
  /** Run the project's `vite build` (inherited stdio). Throws on a nonzero build. */
  runBuild?: (env: NodeJS.ProcessEnv) => void;
  /** Run a static/SPA/SSG preset build command. */
  runStaticBuild?: (command: string, env: NodeJS.ProcessEnv) => void;
  /** Prepare a standalone framework Worker/config after its native build. */
  prepareFrameworkArtifact?: typeof prepareCloudflareFrameworkArtifact;
  /** Upload, readiness-probe, and activate the verified Worker Version. */
  activateVersion?: typeof activateCloudflareVersion;
  /** Read-only metadata transport; writes always use the pinned uploader. */
  metadataFetch?: typeof globalThis.fetch;
  /**
   * Wrangler-uploader content-hash seam (default: {@link hashWranglerUploader}). Snapshotted
   * BEFORE the build and re-checked AFTER, so a build that overwrote the wrangler bundle the
   * credentialed remote migrate / deploy execute fails closed before either runs.
   */
  hashWranglerUploader?: (root: string) => string | undefined;
  /** Provisioner seam (default: `provisionCloudflareResources`, loaded dynamically). */
  provision?: typeof provisionCloudflareResources;
  /** Parent-side secret-gate discharge seam (default: {@link dischargeSelfHostEnvContext}). */
  dischargeSelfHostEnv?: typeof dischargeSelfHostEnvContext;
  /** Persistent Better Auth secret seam (default: {@link ensureCloudflareAuthSecret}). */
  ensureAuthSecret?: typeof ensureCloudflareAuthSecret;
  /** Generated-deploy-config verification seam (default: {@link verifyGeneratedDeployConfig}). */
  verifyDeployConfig?: typeof verifyGeneratedDeployConfig;
  /** Resolve the generated config selected by the fresh deploy pointer. */
  resolveGeneratedConfigPath?: (root: string) => string;
  /** Pre-remote-migrate gate seam (default: {@link assertRemoteMigrationsDeployable}). */
  assertMigrationsDeployable?: typeof assertRemoteMigrationsDeployable;
  /** Migration apply-set equality gate seam (default: {@link checkWranglerMigrationApplySet}). */
  checkMigrationApplySet?: typeof checkWranglerMigrationApplySet;
  /** PostgreSQL migration runner (default: {@link runPgMigrations}). */
  applyPostgresMigrations?: typeof runPgMigrations;
  /** MySQL migration runner (default: {@link runMySqlMigrations}). */
  applyMySqlMigrations?: typeof runMySqlMigrations;
  /**
   * Auth-schema validation seam (default: {@link validateAuthMigrationSchema}).
   * Runs POST-build: reads the generated auth schema the build emitted
   * (`.void/better-auth-schema.ts`) and asserts the checked-in migrations produce it.
   */
  validateAuthMigrations?: typeof validateAuthMigrationSchema;
  /**
   * Isolated env-schema probe seam (default: the {@link EnvSchemaProbeInput}
   * subprocess). Receives a scrubbed env and returns the env-INSENSITIVE schema facts
   * (server and required key names), derived by importing env.ts in the
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
   * `dist/ssr/wrangler.json` — the ground truth the plaintext-server-key + secret gate
   * validate.
   */
  readEmittedWorkerVars?: (root: string) => EmittedWorkerVarsResult;
  /**
   * Override CI / non-interactive detection for the Mode B email prompt (default: wrangler's
   * own {@link isWranglerNonInteractiveOrCI}, so Void and wrangler call the same run
   * interactive).
   */
  isCI?: boolean;
  /**
   * The one-Enter email prompt (default: clack `confirm`, default Yes). Receives the question
   * and resolves the answer; a cancelled prompt is `false`.
   */
  confirmEmailSetup?: (message: string) => Promise<boolean>;
  /** Public-DNS probes for the email preflight (default: `node:dns/promises`). */
  emailDns?: EmailDns;
  /** `fetch` for the two bearer calls wrangler has no command for (default: global `fetch`). */
  emailFetch?: EmailFetch;
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

const BETTER_AUTH_SECRET_NAME = 'BETTER_AUTH_SECRET';

type CloudflareAuthSecretFailureReason =
  | 'uploader-changed'
  | 'list-failed'
  | 'put-failed'
  | 'verification-failed';

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
function isCleanWranglerExit(result: DeployWranglerRunResult): boolean {
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
    // Mirror index.ts's emission signal EXACTLY (line 658): the sandbox container is emitted when
    // `void.config.ts` enables it OR the source imports `void/sandbox` (the import-walk signal). Using
    // `isSandboxEnabled` alone would miss an import-only sandbox app (e.g. kitchen-sink) and the
    // container pin would then FALSE-POSITIVE a legitimate build.
    needsSandbox: bindings.needsSandbox,
    needsLive: bindings.needsLive === true,
  };
}

/** A column the emitted auth schema requires, with the constraints that carry correctness. */
export type RequiredAuthColumn = {
  column: string;
  /** The emitted field is `unique: true` — a duplicate row here is a duplicate auth identity. */
  unique: boolean;
  /**
   * The emitted field is `required: true` — the column must be NOT NULL. `PRAGMA
   * table_info.notnull` answers this directly, with one exception: the `INTEGER PRIMARY KEY`
   * rowid alias reports `notnull = 0` yet SQLite assigns a rowid on a NULL insert, so it can
   * never hold NULL and must not be rejected. A true alias is identified by the ABSENCE of an
   * `origin = 'pk'` row in `PRAGMA index_list`, not by its declared type — `INTEGER PRIMARY
   * KEY DESC` declares the same type but is no alias and really does store NULL.
   */
  required?: boolean;
  /**
   * This is the table's implicit `id` — the row identity every auth foreign key points at.
   * SQLite requires a PARENT KEY to be uniquely constrained (a PRIMARY KEY or a UNIQUE
   * constraint/index), so an `id` that is an ordinary column cannot carry the auth schema's
   * foreign keys. `PRAGMA foreign_key_check` is the authority on whether an EXISTING foreign
   * key's parent key is usable, but it only validates foreign keys that were actually
   * declared — a child table that declares none at all comes back clean. This flag is
   * therefore asserted on its own, so a non-unique `id` is caught even before any child
   * references it.
   */
  primaryKey?: boolean;
  /** The emitted field carries `references` — the parent table + column it must point at. */
  references?: { table: string; column: string };
};

/**
 * One row of `PRAGMA table_info`. `type` is the type the migration DECLARED, echoed back — one
 * of the conditions for recognizing the `INTEGER PRIMARY KEY` rowid alias, which no column of
 * this PRAGMA distinguishes from an ordinary nullable primary key on its own (`PRAGMA
 * index_list` supplies the discriminator).
 */
type TableInfoRow = { name: string; type: string | null; notnull: number; pk: number };

/** One table of the emitted auth schema, reduced to what the migrations must reproduce. */
export type RequiredAuthTable = {
  table: string;
  columns: Array<RequiredAuthColumn>;
};

/**
 * Apply the checked-in migrations to an in-memory SQLite database (`node:sqlite`, a repo
 * dependency — the same driver `auth/node.ts` uses) and assert the effective schema contains
 * every REQUIRED auth table, its columns, AND the constraints that carry correctness. This
 * replaces a raw `CREATE TABLE` token search (defeated by comments/strings/renames/plugin
 * tables) with the real POST-migration schema — the identical thing wrangler will apply to
 * remote D1 (SQLite).
 *
 * Names alone are not enough: Void ships no auth migration scaffolder, so users hand-write
 * `db/schema.ts` and run `void db generate`, where Drizzle's `.unique()` and `.references()`
 * are both opt-in. A migration set with every right NAME but no unique index on `user.email`
 * and no `session.userId` foreign key is a materially weaker schema than the one the managed
 * path builds (`applySqliteAuthMigrations`), and it used to sail through this gate.
 *
 * Asserted: column presence, the implicit `id`'s uniqueness (`primaryKey`), `required`
 * (NOT NULL), `unique: true`, and `references` (parent table + column — including that an
 * implicit `REFERENCES "parent"` resolves to the parent's actual PRIMARY KEY). Those
 * reference checks answer only WHICH column a foreign key names; whether SQLite will ACCEPT
 * that parent key is settled by `PRAGMA foreign_key_check` on the migrated (still empty)
 * database, which applies SQLite's own rule rather than a local re-derivation of it.
 * Deliberately NOT asserted — these would reject legitimate schemas:
 *   - column TYPE — SQLite is dynamically typed, and Drizzle's output varies by mode.
 *   - non-unique `index: true` — a performance property, not a correctness one.
 *   - the exact `onDelete` action — over-tight; the reference itself is the invariant.
 *
 * Throws naming the exact offending `table.column` and what is missing (identifiers only,
 * never values), or when a migration cannot even be applied. Exported for unit testing (the
 * `required` set is passed in, so this needs no Better Auth resolution).
 */
export async function assertMigrationsProduceAuthSchema(
  migrations: Array<{ name: string; sql: string }>,
  required: Array<RequiredAuthTable>,
): Promise<void> {
  const db = await openMigrationValidationDatabase(migrations);
  const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
  // SQLite resolves identifiers case-insensitively, but `sqlite_master.name` and every PRAGMA
  // echo back the casing the migration DECLARED. So `CREATE TABLE "User" ("Email" TEXT UNIQUE)`
  // is the same schema as the emitted `user.email` — lowercase SELECTs resolve against it and
  // the UNIQUE constraint enforces — and must not read as missing here. Every identifier this
  // function compares (table, column, unique index member, FK parent) is folded through this
  // one notion of equality; only the PRAGMA arguments keep the caller's original spelling,
  // since SQLite resolves those case-insensitively anyway.
  const foldIdentifier = (identifier: string): string => identifier.toLowerCase();
  const sameIdentifier = (a: string, b: string): boolean => foldIdentifier(a) === foldIdentifier(b);
  // `PRAGMA table_info`, memoized. A foreign key is validated against the PARENT table's info,
  // and the parent is not necessarily a table this loop has reached (or will ever reach), so
  // this must be able to answer for an arbitrary table at any point. SQLite resolves the PRAGMA
  // argument case-insensitively, so the cache is keyed on the FOLDED name while the query keeps
  // the caller's spelling. A table no migration created yields `[]`, not an error.
  const tableInfoCache = new Map<string, Array<TableInfoRow>>();
  const tableInfoFor = (table: string): Array<TableInfoRow> => {
    const key = foldIdentifier(table);
    const cached = tableInfoCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<TableInfoRow>;
    tableInfoCache.set(key, rows);
    return rows;
  };
  // The table's single-column PRIMARY KEY, or null when it has none or a COMPOSITE one. This is
  // the ONLY thing SQLite resolves an omitted foreign-key target column to.
  const singleColumnPrimaryKey = (table: string): string | null => {
    const primaryKey = tableInfoFor(table).filter((row) => Number(row.pk) > 0);
    return primaryKey.length === 1 && primaryKey[0] ? primaryKey[0].name : null;
  };
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => foldIdentifier(row.name)),
    );
    const problems: Array<string> = [];
    for (const req of required) {
      if (!tables.has(foldIdentifier(req.table))) {
        problems.push(`table "${req.table}" is not created by any checked-in migration`);
        continue;
      }
      const tableInfo = tableInfoFor(req.table);
      const columns = new Set(tableInfo.map((row) => foldIdentifier(row.name)));
      const missing = req.columns
        .filter((required) => !columns.has(foldIdentifier(required.column)))
        .map((required) => required.column);
      if (missing.length > 0) {
        problems.push(`table "${req.table}" is missing column(s): ${missing.join(', ')}`);
      }

      // Uniqueness — collect every column SQLite actually enforces as unique, so BOTH
      // spellings a real project produces are honored: a column-level `email TEXT UNIQUE`
      // (SQLite materializes an implicit `sqlite_autoindex_*`) and a separate
      // `CREATE UNIQUE INDEX ... ON user (email)` (what `applySqliteAuthMigrations` emits).
      // Any single-column, non-partial unique index over the column counts — the index NAME
      // is never required. A single-column PRIMARY KEY counts too, including the
      // `INTEGER PRIMARY KEY` rowid alias, which materializes no `origin = 'pk'` index row.
      const uniqueColumns = new Set<string>();
      const primaryKey = tableInfo.filter((row) => Number(row.pk) > 0);
      if (primaryKey.length === 1 && primaryKey[0]) {
        uniqueColumns.add(foldIdentifier(primaryKey[0].name));
      }
      const indexes = db.prepare(`PRAGMA index_list(${quote(req.table)})`).all() as Array<{
        name: string;
        unique: number;
        origin?: string | null;
        partial?: number;
      }>;
      for (const index of indexes) {
        // A PARTIAL unique index only constrains the rows matching its WHERE clause, so it
        // does not make the column globally unique.
        if (Number(index.unique) !== 1 || Number(index.partial ?? 0) !== 0) {
          continue;
        }
        const indexColumns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all() as Array<{
          name: string | null;
        }>;
        // A composite unique index constrains the TUPLE, not this column on its own.
        if (indexColumns.length !== 1) {
          continue;
        }
        const only = indexColumns[0]?.name;
        if (typeof only === 'string') {
          uniqueColumns.add(foldIdentifier(only));
        }
      }
      // The implicit `id` — the parent key every auth foreign key resolves against. SQLite
      // only accepts a parent key that is uniquely constrained, so a migration that creates
      // `id` as an ordinary column produces a schema whose FKs are DEAD: `CREATE TABLE`
      // succeeds, `PRAGMA foreign_key_list` still reports the constraint, and then every
      // statement touching the child table fails at prepare time with `foreign key mismatch`
      // under `foreign_keys=ON` (which D1 always enforces) — i.e. auth breaks in production
      // AFTER a green deploy. PRIMARY KEY and UNIQUE are both valid parent keys, so reuse
      // `uniqueColumns` (it already accepts the single-column PK, the `INTEGER PRIMARY KEY`
      // rowid alias, and any single-column non-partial unique index) rather than demanding
      // PRIMARY KEY specifically.
      const notIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of notIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be the PRIMARY KEY (or otherwise ` +
            `uniquely constrained) — it is the row identity the auth foreign keys point at, and ` +
            `SQLite rejects a foreign key whose parent key is not unique at runtime with ` +
            `"foreign key mismatch"`,
        );
      }

      // NOT NULL — `PRAGMA table_info.notnull` answers it directly, with ONE exception. The
      // `INTEGER PRIMARY KEY` rowid alias reports `notnull = 0`, but SQLite assigns a rowid on
      // a NULL insert, so the column can never actually hold NULL; rejecting it would false-
      // reject a common, legitimate schema.
      //
      // The declared type CANNOT decide this on its own. `INTEGER PRIMARY KEY DESC` is not a
      // rowid alias — a historical SQLite quirk — yet `PRAGMA table_info` reports it
      // identically to the real alias (`type = INTEGER`, `pk = 1`, `notnull = 0`) while a NULL
      // insert genuinely stores NULL. What separates them is that a true alias IS the rowid,
      // so SQLite materializes no primary-key index for it: `PRAGMA index_list` carries an
      // `origin = 'pk'` row for `DESC`, for `TEXT PRIMARY KEY`, for `INT`/`BIGINT PRIMARY KEY`
      // and for a composite PK, but none for `INTEGER PRIMARY KEY` / `INTEGER PRIMARY KEY ASC`.
      // That is the discriminator used here — the absence of the `origin = 'pk'` row, read off
      // the `index_list` the uniqueness check above already fetched, with no SQL text parsing.
      // Note the test is the ORIGIN, not the row count: a rowid-alias table may still carry
      // unrelated `origin = 'u'` / `origin = 'c'` index rows from a column-level UNIQUE or a
      // `CREATE INDEX`. The single-column-PK and exact-`INTEGER` conditions are kept alongside
      // it, so nothing widens beyond the one shape SQLite actually aliases to the rowid.
      const hasPrimaryKeyIndex = indexes.some(
        (index) => String(index.origin ?? '').toLowerCase() === 'pk',
      );
      const isRowidAlias = (row: TableInfoRow): boolean =>
        primaryKey.length === 1 &&
        Number(row.pk) > 0 &&
        !hasPrimaryKeyIndex &&
        String(row.type ?? '')
          .trim()
          .toUpperCase() === 'INTEGER';
      const notNullColumns = new Set(
        tableInfo
          .filter((row) => Number(row.notnull) === 1 || isRowidAlias(row))
          .map((row) => foldIdentifier(row.name)),
      );

      // The identity's own NOT NULL. SQLite permits NULL in any PRIMARY KEY column that is not
      // the rowid alias — a longstanding file-format compatibility quirk — so `id text primary
      // key` accepts rows carrying NO identity, and more than one of them, because NULLs never
      // collide under a unique constraint. Reported apart from the ordinary required columns
      // below: the constraint reads as already satisfied in the migration, so the message has
      // to name the quirk to be actionable.
      const nullableIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            required.required === true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of nullableIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be declared NOT NULL — SQLite permits ` +
            `NULL in a PRIMARY KEY column unless it is the INTEGER rowid alias, so rows could ` +
            `be inserted with no identity at all, and more than one of them (NULLs do not ` +
            `collide under a unique constraint)`,
        );
      }

      // Every other column the emitted schema marks `required`.
      const nullableRequired = req.columns
        .filter(
          (required) =>
            required.required === true &&
            required.primaryKey !== true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (nullableRequired.length > 0) {
        problems.push(
          `table "${req.table}" is missing a NOT NULL constraint on column(s): ` +
            `${nullableRequired.join(', ')} (the emitted auth schema marks them required)`,
        );
      }

      const notUnique = req.columns
        .filter(
          (required) =>
            required.unique &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (notUnique.length > 0) {
        problems.push(
          `table "${req.table}" is missing a UNIQUE constraint on column(s): ${notUnique.join(', ')} ` +
            `(no column-level UNIQUE and no single-column unique index covers them)`,
        );
      }

      // References — the emitted schema points these columns at a parent row, and without the
      // foreign key the migrations permit orphaned auth rows (e.g. a session with no user).
      // `PRAGMA foreign_key_list` returns ONE ROW PER COLUMN, not one per constraint: the rows
      // of a single constraint share an `id` and are ordered by `seq`. Grouping by `id` is what
      // makes the width of each constraint visible, and the width is load-bearing — see below.
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${quote(req.table)})`)
        .all() as Array<{
        id: number;
        table: string;
        from: string;
        to: string | null;
      }>;
      const foreignKeyConstraints = new Map<number, Array<(typeof foreignKeys)[number]>>();
      for (const fk of foreignKeys) {
        const group = foreignKeyConstraints.get(Number(fk.id));
        if (group) {
          group.push(fk);
        } else {
          foreignKeyConstraints.set(Number(fk.id), [fk]);
        }
      }
      const constraints = Array.from(foreignKeyConstraints.values());
      for (const required of req.columns) {
        const reference = required.references;
        if (!reference || !columns.has(foldIdentifier(required.column))) {
          continue;
        }
        const namesReference = (fk: (typeof foreignKeys)[number]): boolean =>
          typeof fk.from === 'string' &&
          sameIdentifier(fk.from, required.column) &&
          typeof fk.table === 'string' &&
          sameIdentifier(fk.table, reference.table);
        // ONLY a SINGLE-COLUMN foreign key satisfies an auth reference. SQLite applies
        // MATCH SIMPLE, under which a COMPOSITE foreign key is skipped ENTIRELY whenever ANY
        // of its child columns is NULL — so `FOREIGN KEY (userId, tenant) REFERENCES
        // user(id, tenant)` with a nullable `tenant` lets a session naming a nonexistent user
        // be inserted, exactly the orphan the `references` requirement exists to prevent.
        // Matching per ROW would accept that constraint through its `userId` member alone.
        // `PRAGMA foreign_key_check` cannot cover for this either: it reports orphaned DATA,
        // and the freshly-migrated database it runs against holds no rows.
        const matching = constraints.flatMap((group) =>
          group.length === 1 && group[0] && namesReference(group[0]) ? [group[0]] : [],
        );
        const composite = constraints.some(
          (group) => group.length > 1 && group.some(namesReference),
        );
        // WHICH COLUMN the foreign key points at — a question of NAMES, and the only
        // question this block answers. Whether SQLite will ACCEPT that parent key at all is
        // orthogonal and is settled below by `PRAGMA foreign_key_check`, so nothing here
        // needs to model SQLite's parent-key rules.
        //
        // `to` is NULL when the migration omitted the target column (`REFERENCES "user"`).
        // SQLite resolves an omitted target ONLY to the parent's single-column PRIMARY KEY,
        // so the shorthand names the required column only when that column IS the parent's
        // PRIMARY KEY. The answer lives only in the PARENT's own `table_info`, which is why
        // this reaches outside the table being validated. This check is load-bearing beyond
        // the pragma: a foreign key aimed at a perfectly valid parent key that is the WRONG
        // column (`REFERENCES "user"` where the parent's PRIMARY KEY is `email`, not `id`)
        // is structurally sound, so `foreign_key_check` passes it — only this comparison
        // catches it. An EXPLICIT `to` matches by name directly.
        const satisfied = matching.some((fk) => {
          if (fk.to != null) {
            return sameIdentifier(String(fk.to), reference.column);
          }
          const parentPrimaryKey = singleColumnPrimaryKey(fk.table);
          return parentPrimaryKey !== null && sameIdentifier(parentPrimaryKey, reference.column);
        });
        if (!satisfied) {
          problems.push(
            matching.length === 0 && composite
              ? `table "${req.table}" column "${required.column}" references ` +
                  `"${reference.table}"."${reference.column}" only as part of a MULTI-COLUMN ` +
                  `foreign key — SQLite skips a composite foreign key entirely when any of its ` +
                  `child columns is NULL, so a row naming a "${reference.table}" that does not ` +
                  `exist is still accepted. This reference needs its own single-column foreign ` +
                  `key on "${required.column}"`
              : matching.some((fk) => fk.to == null)
                ? `table "${req.table}" column "${required.column}" references "${reference.table}" ` +
                  `without naming a target column, but "${reference.table}"."${reference.column}" ` +
                  `is not that table's single-column PRIMARY KEY — SQLite resolves an omitted ` +
                  `target only to the parent's PRIMARY KEY (a UNIQUE constraint does not qualify, ` +
                  `nor does a composite PRIMARY KEY) and rejects this at runtime with ` +
                  `"foreign key mismatch"`
                : `table "${req.table}" column "${required.column}" is missing a foreign key ` +
                  `referencing "${reference.table}"."${reference.column}"`,
          );
        }
      }

      // AUTHORITATIVE structural gate for this table's foreign keys — ask SQLite instead of
      // re-deriving its parent-key rules here. Those rules are subtler than they look: a
      // parent key must be a PRIMARY KEY, or a UNIQUE index whose columns AND COLLATING
      // SEQUENCES match the reference, and an omitted target column resolves only to the
      // parent's PRIMARY KEY. Hand-modelling them has produced a green deploy on a schema
      // SQLite rejects more than once (an ordinary parent column; a UNIQUE-only parent under
      // the implicit shorthand; a unique index declared `COLLATE NOCASE` over a plainly
      // declared column). `PRAGMA foreign_key_check` applies SQLite's own rule, so a case
      // this file has not anticipated can no longer pass.
      //
      // It reports a STRUCTURAL mismatch by THROWING (`foreign key mismatch - "child"
      // referencing "parent"`), not by returning rows; returned rows mean orphaned DATA,
      // which a freshly-migrated database holding no rows cannot have, but are surfaced too
      // so neither outcome is silently dropped. Scoped to this table (the CHILD side) so an
      // unrelated application table with its own broken foreign key is not this gate's
      // business. Any other error is a real fault and propagates untouched.
      //
      // Why this matters: `CREATE TABLE` accepts a dead foreign key, and `PRAGMA
      // foreign_key_list` echoes it back as if valid. Only when a statement touches the
      // child does SQLite fail at PREPARE time with `foreign key mismatch` — under
      // `foreign_keys=ON`, which D1 always enforces. Without this gate that surfaces as auth
      // breaking in production AFTER a green deploy.
      try {
        const violations = db
          .prepare(`PRAGMA foreign_key_check(${quote(req.table)})`)
          .all() as Array<{ parent?: string | null }>;
        for (const violation of violations) {
          const parent = typeof violation.parent === 'string' ? violation.parent : 'its parent';
          problems.push(
            `table "${req.table}" has rows violating its foreign key to "${parent}" ` +
              `(PRAGMA foreign_key_check)`,
          );
        }
      } catch (err) {
        const message = getErrorMessage(err);
        const mismatch = /foreign key mismatch\s*-\s*"(.+?)"\s+referencing\s+"(.+?)"/i.exec(
          message,
        );
        if (!mismatch) {
          throw err;
        }
        problems.push(
          `table "${mismatch[1]}" has a foreign key referencing "${mismatch[2]}" whose parent ` +
            `key is not a valid foreign-key target — SQLite requires the referenced column(s) ` +
            `to be a PRIMARY KEY, or a UNIQUE index that MATCHES the reference (an index ` +
            `declared with a different COLLATE does not match), and an omitted target column ` +
            `resolves only to the parent's PRIMARY KEY. The table is created, but SQLite ` +
            `rejects every statement touching it at runtime with "foreign key mismatch"`,
        );
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
 * columns — matching `resolveVoidAuthMigrationSchema`'s field set exactly. Each field
 * also carries its `required` (NOT NULL) and `unique` flags and its `references` target,
 * so the check below can assert the CONSTRAINTS the schema requires and not merely the
 * names. Throws a fail-closed error when the artifact is missing/malformed.
 */
function readEmittedAuthMigrationSchema(root: string): Array<RequiredAuthTable> {
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
    columns: [
      // `id` is the implicit PRIMARY KEY — never carries `unique`/`references` of its own,
      // and is absent from `fields`, so this synthesized descriptor is the ONLY thing that
      // represents it. `primaryKey` makes the check assert it is a usable FK parent key
      // (see {@link RequiredAuthColumn.primaryKey}); `required` makes it assert the column
      // cannot be NULL, which PRIMARY KEY alone does not guarantee in SQLite.
      { column: 'id', unique: false, required: true, primaryKey: true },
      ...Object.entries(table.fields).map(([column, field]) => ({
        column,
        unique: field.unique === true,
        required: field.required === true,
        references: field.references
          ? { table: field.references.table, column: field.references.field }
          : undefined,
      })),
    ],
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
 * wrangler 4.131's own migration-file order comparator, reproduced EXACTLY
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

export function resolveWranglerMigrationPattern(
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
): { ok: true; pattern: string } | { ok: false; reason: string } {
  const field = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_pattern');
  const migrationsDir = normalize(migrationsDirRaw.replace(/\\/g, '/')).replace(/\/$/, '');
  if (!field.present) {
    return { ok: true, pattern: '*.sql' };
  }
  const directoryField = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_dir',
  );
  if (!directoryField.present) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern for D1 binding ${binding} requires an explicit ` +
        'migrations_dir in the same binding.',
    };
  }
  if (typeof field.value !== 'string' || field.value.length === 0) {
    return {
      ok: false,
      reason: `deploy: migrations_pattern for D1 binding ${binding} must be a non-empty string.`,
    };
  }
  const normalized = normalize(field.value.replace(/\\/g, '/')).replace(/\/$/, '');
  const prefix = migrationsDir === '.' ? '' : `${migrationsDir}/`;
  if (prefix && !normalized.startsWith(prefix)) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern ${JSON.stringify(field.value)} must start with ` +
        `${JSON.stringify(`${migrationsDir}/`)} to match migrations_dir ${JSON.stringify(migrationsDirRaw)}.`,
    };
  }
  const pattern = prefix ? normalized.slice(prefix.length) : normalized;
  try {
    new Minimatch(pattern, { dot: false });
  } catch (error) {
    return {
      ok: false,
      reason: `deploy: invalid migrations_pattern ${JSON.stringify(field.value)} — ${getErrorMessage(error)}`,
    };
  }
  return { ok: true, pattern };
}

function listWranglerMigrationFiles(directory: string, pattern: string): Array<string> {
  const matcher = new Minimatch(pattern, { dot: false });
  const files: Array<string> = [];
  const visit = (absolute: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(absolute, entry.name), relativePath);
      } else if (entry.isFile() && matcher.match(relativePath)) {
        files.push(relativePath);
      }
    }
  };
  visit(directory, '');
  return files.sort(compareWranglerMigrationPaths);
}

/**
 * Assert the migration files wrangler 4.131 will APPLY — in the ORDER it applies them — equal
 * the gated source set. wrangler resolves its OWN files from the D1 entry's `migrations_dir`
 * (relative to the config-file dir) with either the default `<dir>/*.sql` pattern or the
 * configured `migrations_pattern`, tracks each by its relative `.sql` name, and applies them
 * sorted by its numeric-prefix comparator ({@link compareWranglerMigrationPaths}) — the exact
 * sequence `d1 migrations apply` runs against REMOTE D1. This backend VALIDATES the set
 * `collectMigrations` reads (flat dir, `seed.sql` excluded, sorted lexicographically). Two
 * things must hold: (1) SET equality by name AND content — a stray/extra file (e.g. `seed.sql`,
 * which `collectMigrations` skips but wrangler's `*.sql` matches), a differing dir, or a
 * divergent content would otherwise be applied UNVALIDATED; and (2) ORDER parity — the numeric
 * order wrangler applies must equal Void's gated order position-for-position, so the local
 * runner + deploy gates validate the exact order remote D1 receives (an unpadded prefix like
 * `2_` vs `10_` sorts differently lexicographically-vs-numerically and diverges — reject). A
 * custom patterns are accepted only when their exact result matches that gated set. Exported for
 * unit testing.
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
  const resolvedPattern = resolveWranglerMigrationPattern(config, binding, migrationsDirRaw);
  if (!resolvedPattern.ok) {
    return resolvedPattern;
  }
  const wranglerNames = listWranglerMigrationFiles(absDir, resolvedPattern.pattern);
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

/** Run typed provider operations in the pinned account and API context. */
export function createDeployWranglerRunner(
  root: string,
  accountId: string | undefined,
  apiBaseUrl: string,
): DeployWranglerRun {
  const runner = createCloudflareProcessRunner({
    root,
    accountId,
    apiBaseUrl,
    env: () => deployChildEnv(accountId, apiBaseUrl),
  });
  return (operation, opts) => runner(operation, opts);
}

/** Retry an existing-Worker read only when a fresh identity check proves the session is gone. */
async function prepareExistingCloudflareDeployWithAuth(
  options: Parameters<typeof prepareExistingCloudflareDeploy>[0],
  beforeRun: () => boolean,
): Promise<ExistingCloudflareWorker | null> {
  try {
    return await prepareExistingCloudflareDeploy(options);
  } catch (error) {
    if (!(error instanceof CloudflareWorkerInspectionError)) {
      throw error;
    }
    if (!beforeRun()) {
      throw new CloudflareAuthenticationError(
        'The Cloudflare uploader changed during Worker verification.',
        'uploader-changed',
      );
    }
    const configPath = existsSync(options.configPath) ? options.configPath : undefined;
    const identity = await options.runWrangler(
      { type: 'auth.whoami', configPath },
      {
        capture: true,
      },
    );
    const session = isCleanWranglerExit(identity)
      ? parseCloudflareAuthSession(identity.data)
      : null;
    const wrongAccount =
      session !== null &&
      session.accounts.length > 0 &&
      !session.accounts.some((account) => account.id === options.accountId);
    if (session && !wrongAccount) {
      // Authentication works. Preserve the original Worker/permission error.
      throw error;
    }
    let loggedOut = false;
    try {
      loggedOut = (identity.data as { loggedIn?: unknown } | undefined)?.loggedIn === false;
    } catch {
      /* The auth command may have failed before producing JSON. */
    }
    const authenticationError =
      loggedOut ||
      wrongAccount ||
      /authentication is required|not authenticated|no api token|invalid.*token|expired.*token|unauthorized/i.test(
        identity.stderr,
      );
    if (!authenticationError || identity.signal || identity.error) {
      throw new Error(
        'Could not verify the Cloudflare session after the Worker check failed. Run `void cloudflare status` and retry.',
      );
    }
    const overrides = cloudflareCredentialOverrides();
    if (overrides.length > 0) {
      throw new Error(
        `Cloudflare credentials from ${overrides.join(', ')} were rejected or cannot access account ${options.accountId}. Correct or unset them, then retry the deploy.`,
      );
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        wrongAccount
          ? `The Cloudflare session cannot access account ${options.accountId}. Run \`void cloudflare login\` with the correct user, or set a token for that account in CI, then retry.`
          : 'Cloudflare authentication expired or is unavailable. Run `void cloudflare login` in a terminal, or set CLOUDFLARE_API_TOKEN in CI, then retry.',
      );
    }
    log.warn(
      wrongAccount
        ? 'The current Cloudflare session cannot access the deployment account. Signing in before retrying the Worker check.'
        : 'Cloudflare session is unavailable. Signing in before retrying the Worker check.',
    );
    const authenticated = await ensureCloudflareAuthentication({
      forceLogin: true,
      requireAccounts: true,
      beforeRun,
      runWrangler: (operation, capture) => options.runWrangler(operation, { capture }),
      configPath,
    });
    if (!authenticated.accounts.some((account) => account.id === options.accountId)) {
      throw new Error(
        `The signed-in Cloudflare user cannot access account ${options.accountId}. Sign in with a user who can access it, then retry.`,
      );
    }
    if (!beforeRun()) {
      throw new CloudflareAuthenticationError(
        'The Cloudflare uploader changed during sign-in.',
        'uploader-changed',
      );
    }
    return await prepareExistingCloudflareDeploy(options);
  }
}

async function chooseCloudflareDeployAccount(options: {
  persist?: boolean;
  beforeWranglerRun: () => boolean;
  configPath: string;
  root: string;
  runWrangler: DeployWranglerRun;
}): Promise<string> {
  const session = await ensureCloudflareAuthentication({
    beforeRun: options.beforeWranglerRun,
    requireAccounts: true,
    runWrangler: (operation, capture) => options.runWrangler(operation, { capture }),
    configPath: existsSync(options.configPath) ? options.configPath : undefined,
  });
  const accounts = session.accounts;
  let account = accounts[0]!;
  if (accounts.length > 1) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Multiple Cloudflare accounts are available. Set CLOUDFLARE_ACCOUNT_ID in CI, or run `void init` interactively to choose one.',
      );
    }
    const accountId = await select({
      message: 'Choose a Cloudflare account:',
      initialValue: account.id,
      options: accounts.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        hint: candidate.id,
      })),
    });
    if (isCancel(accountId) || typeof accountId === 'symbol') {
      throw new Error('Cloudflare account selection was cancelled.');
    }
    account = accounts.find((candidate) => candidate.id === accountId) ?? account;
  }
  if (options.persist !== false) {
    writeProvisionedWranglerConfig(
      options.root,
      { accountId: account.id },
      { configPath: options.configPath },
    );
  }
  log.success(`Configured Cloudflare account: ${account.name}`);
  return account.id;
}

/**
 * wrangler's own interactivity gate (`isNonInteractiveOrCI`, workers-utils): `ci-info`'s `isCI`
 * OR either stdio not a TTY. The email step (3b-ii) uses THIS rather than the deploy's `isCI`
 * (stdin-only, or a CI token source): wrangler asks its own y/n on a destructive `addresses`
 * plan change after the upload under the same gate, and the two halves of one deploy must call
 * the same run interactive — otherwise Void would prompt where wrangler then throws in "CI", or
 * skip a prompt wrangler goes on to ask.
 */
export function isWranglerNonInteractiveOrCI(): boolean {
  return ciInfoIsCI || !(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Borrow the wrangler session's bearer for the two email calls wrangler has no command for
 * (0078 "The flow, by lane": subdomain routing enable, the subaddressing PATCH, plus the
 * read-only zone classification). Spawns `wrangler auth token --json` through the deploy runner
 * — the pinned uploader, the pinned account + API base — with `WRANGLER_WRITE_LOGS=false`
 * layered on the child env: without it wrangler appends the token to
 * `~/.wrangler/logs/wrangler-*.log`, mode `-rw-r--r--` (`shouldLogToDisk`). The captured stdout
 * is parsed and the token string is handed to the caller's closure ONLY: it is never logged,
 * never placed in `process.env` or any later child env, and never part of an error — every
 * failure resolves `null`, which the email module reports as "session bearer unavailable".
 */
export async function runWranglerAuthToken(
  runWrangler: DeployWranglerRun,
  configPath: string,
): Promise<string | null> {
  let result: DeployWranglerRunResult;
  try {
    result = await Promise.resolve(
      runWrangler(
        { type: 'auth.token', configPath },
        {
          capture: true,
          env: { WRANGLER_WRITE_LOGS: 'false' },
        },
      ),
    );
  } catch {
    return null;
  }
  if (!isCleanWranglerExit(result)) {
    return null;
  }
  const parsed = result.data as { type?: unknown; token?: unknown } | null | undefined;
  // An `api_key` session answers `{ key, email }` — there is no single bearer to borrow.
  const type = parsed?.type;
  const token = parsed?.token;
  return (type === 'oauth' || type === 'api_token') && typeof token === 'string' && token.length > 0
    ? token
    : null;
}

/** What the post-deploy address map prints — the input of {@link renderAddressMap}. */
type EmailAddressMapInput = Parameters<typeof renderAddressMap>[0];

interface CloudflareEmailStepInput {
  root: string;
  configPath: string;
  voidConfig: VoidConfig;
  /** The pre-probe root config (step 3) — `send_email` / `addresses` are read from it. */
  rootConfig: Record<string, unknown>;
  handlers: EmailHandlersScan;
  workerName: string;
  accountId: string;
  /** The ONE pinned transport (3a) — the two bearer `fetch` calls follow it like every wrangler child. */
  apiBaseUrl: string;
  runWrangler: DeployWranglerRun;
  /** wrangler's gate ({@link isWranglerNonInteractiveOrCI}) or the test override. */
  nonInteractive: boolean;
  confirm: (message: string) => Promise<boolean>;
  fetchImpl: EmailFetch;
  dns: EmailDns;
}

interface CloudflareEmailStepResult {
  /**
   * True when the step FINISHED: every row read ready, or the one Enter applied the rest.
   * What `--require-email` gates on. A worker can still SHIP with email (the `SEND_EMAIL`
   * binding committed) on a branch that returns false — `map` says so.
   */
  satisfied: boolean;
  /** True when the root wrangler config was rewritten — the caller re-parses `rootConfig`. */
  configWritten: boolean;
  /** Stop before project code, the build, or upload; used for an ambiguous DNS handoff. */
  abortDeploy?: true;
  /** The post-deploy address map, when the worker ships with the binding; `null` otherwise. */
  map: EmailAddressMapInput | null;
}

/**
 * Immediately after setup, the local resolver can retain ENODATA while Cloudflare's public DNS
 * already serves the new subdomain MX. When the committed config is exactly setup's plan and
 * every other inbound prerequisite is still ready, DNS is ambiguous: deleting `addresses`
 * destroys the handoff, while deploying it could fail after upload if routing is genuinely off.
 */
function isCommittedSubdomainPlanWaitingForDns(
  pre: EmailPreflight,
  rootConfig: Record<string, unknown>,
): boolean {
  if (
    pre.mode !== 'subdomain' ||
    (pre.domainMx.state !== 'empty' && pre.domainMx.state !== 'unknown') ||
    pre.routing.enabled !== true ||
    pre.subaddressing.state !== 'on' ||
    pre.binding.state !== 'present' ||
    pre.sender.state !== 'ready' ||
    pre.addressesOwnership.state !== 'mine' ||
    pre.addressesStale ||
    pre.rules.state === 'unknown' ||
    pre.rules.foreign.length > 0 ||
    !Array.isArray(rootConfig.addresses) ||
    rootConfig.addresses.length === 0
  ) {
    return false;
  }

  const allBlockers = pre.blockers.filter((blocker) => blocker.scope === 'all');
  if (pre.domainMx.state === 'empty') {
    return allBlockers.length === 0;
  }
  // `preflightEmail` always adds one all-scope blocker for an unknown domain MX. Exactly one
  // therefore means DNS is the only such blocker, without coupling this gate to rendered prose.
  return allBlockers.length === 1;
}

/**
 * Step 3b-ii — Mode B email on the developer's own account (design doc 0078, "One keystroke").
 * Preflight is read-only; the checklist is shown; ONE `confirm` (default Yes) authorizes the
 * apply, which runs only the rows not ready and returns the root-config patch this writes.
 * Most branches that cannot finish return `satisfied: false`, leaving `--require-email` to
 * decide whether deployment continues. One ambiguous handoff fails closed for every deploy:
 * an exact committed subdomain plan whose new MX is still empty or unreadable. It is preserved,
 * and the caller stops before build/upload until DNS can be verified. No output of this step
 * ever contains the session bearer: the module borrows it through `getSessionBearer` inside its
 * own closures and drops it.
 */
async function runCloudflareEmailStep(
  input: CloudflareEmailStepInput,
): Promise<CloudflareEmailStepResult> {
  const without: CloudflareEmailStepResult = { satisfied: false, configWritten: false, map: null };
  const from = input.voidConfig.email?.from;
  if (!from) {
    log.warn(
      [
        'deploy: this app uses email, but void.config.ts names no sender.',
        'Set email.from to "you@mail.acme.com" in void.config.ts — deploying without email.',
      ].join('\n'),
    );
    return without;
  }
  const { rootConfig } = input;
  const configName = basename(input.configPath);
  const inputs: EmailCloudflareInputs = {
    handlers: input.handlers,
    from,
    workerName: input.workerName,
    accountId: input.accountId,
    existingSendEmail: Array.isArray(rootConfig.send_email)
      ? (rootConfig.send_email as Array<{ name?: unknown }>)
      : undefined,
    existingAddresses: rootConfig.addresses,
    existingVars:
      rootConfig.vars && typeof rootConfig.vars === 'object' && !Array.isArray(rootConfig.vars)
        ? (rootConfig.vars as Record<string, unknown>)
        : undefined,
    configConflicts: findEmailConfigConflicts(rootConfig),
    // The SAME `-c`/`--env=` context every other credentialed wrangler run gets.
    configPath: input.configPath,
    apiBaseUrl: input.apiBaseUrl,
    runWrangler: input.runWrangler,
    getSessionBearer: () => runWranglerAuthToken(input.runWrangler, input.configPath),
    fetchImpl: input.fetchImpl,
    dns: input.dns,
  };

  let pre: EmailPreflight;
  try {
    pre = await preflightEmail(inputs);
  } catch (err) {
    log.warn(`deploy: email preflight failed — ${getErrorMessage(err)}. Deploying without email.`);
    return without;
  }
  const mapFor = (
    addresses: Array<string>,
    sendingReady: boolean,
    creating: Array<string> = [],
  ): EmailAddressMapInput => ({
    from,
    routes: pre.derived.routes,
    addresses,
    sendingReady,
    creating,
  });
  // Pin `configPath` so read/parse/write hit the SAME file every other step uses. A refused
  // write (e.g. an `addresses` array with a comment nested inside it) is the developer's
  // territory (decision 13): surface it as-is; the caller decides what the deploy ships.
  const writeConfig = (patch: ProvisionedWranglerPatch): boolean => {
    try {
      writeProvisionedWranglerConfig(input.root, patch, { configPath: input.configPath });
      return true;
    } catch (err) {
      log.error(`deploy: could not update ${configName} — ${getErrorMessage(err)}.`);
      return false;
    }
  };

  // Every account row ready: no prompt, no account call, zero keystrokes (the second deploy).
  // A sending row the committed binding remembers as refused (Workers Free) lands here too
  // — the deploy never retries the onboarding; the map ends `(verified destinations only)`
  // and `void email setup` is where the retry is offered (`preflightEmail`'s memory rule).
  // The two CONFIG rows are reconciled here by a plain file write, because a stale one is
  // not idle: an `addresses` entry no longer in the pruned set reaches wrangler's plan as a
  // `conflict` (a takeover prompt in a TTY, a UserError after the upload in CI — decision
  // 12), and a stale `__VOID_EMAIL_FROM` ships the OLD sender while the map prints the new.
  //
  // The `null` (key removed) branch below is reachable in exactly one shape: every derived
  // address is routed elsewhere (a forward, another worker — a worker rename makes all of
  // them so), so this worker OWNS none of those rules and `[]` would plan nothing either;
  // the key goes because a plan on a stale entry is a `conflict`. A handler deleted while
  // its entry stays never gets here: the preflight (step 8) has no provenance for entries
  // Void wrote on an earlier deploy, so it reads that leftover as an entry Void did not
  // derive — the decision-13 blocker, array untouched, rule still routed to this worker
  // (guide: "Deleting a handler leaves its address in `addresses`"). Making the leftover
  // Void-managed instead (a marker like `void:managed-queues`, then `[]` or a prune) is
  // decision 13's other branch, and under `triggers deploy` a `[]` plan that deletes owned
  // rules is destructive: wrangler asks (default No) in a TTY and throws in CI, which the
  // activation reports as `triggers-failed` and compensates by restoring the previous
  // version. A product call, not a deploy default.
  if (pre.ready) {
    const patch: ProvisionedWranglerPatch = {};
    const rows: Array<string> = [];
    if (pre.addressesStale) {
      patch.addresses = pre.addresses.length > 0 ? pre.addresses : null;
      rows.push(
        pre.addresses.length > 0
          ? `addresses: ${JSON.stringify(pre.addresses)}`
          : 'addresses removed',
      );
    }
    if (pre.sender.state !== 'ready') {
      patch.vars = { [EMAIL_FROM_VAR]: from };
      rows.push(`vars.${EMAIL_FROM_VAR}: ${JSON.stringify(from)}`);
    }
    let configWritten = false;
    if (rows.length > 0) {
      // The prune rows the checklist would have carried: say why an entry goes.
      for (const foreign of pre.addressesStale ? pre.rules.foreign : []) {
        log.message(
          `    ! ${foreign.address}: already routed to ${foreign.owner}; left alone, not in addresses`,
        );
      }
      if (!writeConfig(patch)) {
        log.warn(`deploy: deploying with the email setup ${configName} already carries.`);
        return {
          ...without,
          map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
        };
      }
      configWritten = true;
      log.message(`  ✔ config    ${configName} updated (${rows.join(', ')})`);
    }
    return {
      satisfied: true,
      configWritten,
      map: mapFor(pre.addresses, pre.sending.state === 'ready', pre.rulesPending),
    };
  }

  // The checklist carries the `✘` rows, so a blocked run explains itself before the warn line.
  log.message(renderEmailChecklist(pre));
  if (isCommittedSubdomainPlanWaitingForDns(pre, rootConfig)) {
    const dnsState =
      pre.domainMx.state === 'empty'
        ? 'this resolver sees no MX records yet'
        : 'the MX lookup failed';
    log.error(
      [
        `deploy: cannot verify Email Routing on ${pre.domain} because ${dnsState}.`,
        `The existing addresses plan in ${configName} is preserved. DNS may still be propagating after \`void email setup\`; run \`void email status --platform cloudflare\` and retry the deploy when this resolver sees Cloudflare's MX records.`,
        'Nothing was built or uploaded.',
      ].join('\n'),
    );
    return {
      ...without,
      abortDeploy: true,
      map: mapFor(existingAddresses(rootConfig, pre), pre.sending.state === 'ready'),
    };
  }
  // The three exits below leave the account alone. What the worker then ships is whatever
  // the config already carries — so when the binding is committed the deploy is WITH the
  // existing setup (map printed, wording says so). A committed `addresses` array whose routing
  // is verifiably off is withdrawn first: wrangler's plan on it 400s (`2062`) AFTER the upload,
  // on every deploy, until the key goes (0078: "deleted, never `[]`, when a later preflight finds
  // routing off"). The ambiguous post-setup DNS case returned above instead. Only Void's own
  // array is touched (decision 13); deleting the KEY changes no rule — wrangler skips the plan.
  const shipsBinding = pre.binding.state === 'present';
  const leaveAccount = (reason: string): CloudflareEmailStepResult => {
    let configWritten = false;
    if (
      Array.isArray(rootConfig.addresses) &&
      pre.addressesOwnership.state === 'mine' &&
      pre.routing.state !== 'ready'
    ) {
      // A refused write leaves the array where it is; the deploy goes on as it would have.
      if (writeConfig({ addresses: null })) {
        configWritten = true;
        log.message(
          `  ! config    addresses removed from ${configName} (routing on ${pre.domain} is ${pre.routing.state}); no routing rule is created for ${(rootConfig.addresses as Array<unknown>).map(String).join(', ')}`,
        );
      }
    }
    log.warn(
      `deploy: ${reason} — ${shipsBinding ? `deploying with the email setup ${configName} already carries.` : 'deploying without email.'}`,
    );
    return {
      satisfied: false,
      configWritten,
      map: shipsBinding
        ? mapFor(
            configWritten ? [] : existingAddresses(rootConfig, pre),
            pre.sending.state === 'ready',
          )
        : null,
    };
  };
  if (pre.blockers.some((b) => b.scope === 'all')) {
    return leaveAccount(`email on ${pre.domain} cannot be set up from here.`);
  }
  if (input.nonInteractive) {
    return leaveAccount(
      [
        `email on ${pre.domain} is not ${shipsBinding ? 'fully ' : ''}set up, and this shell cannot ask.`,
        'Run `void email setup --platform cloudflare` once locally, commit void.lock.json, then redeploy.',
      ].join('\n'),
    );
  }
  if (!(await input.confirm(`Set up email on ${pre.domain}?`))) {
    return leaveAccount(
      'email setup skipped — run `void email setup --platform cloudflare` later.',
    );
  }

  const out = await applyEmailSetup(pre, inputs);
  if (out.lines.length > 0) {
    log.message(out.lines.join('\n'));
  }
  let configWritten = false;
  if (
    out.patch.sendEmail !== undefined ||
    out.patch.addresses !== undefined ||
    out.patch.vars !== undefined
  ) {
    if (
      !writeConfig({
        sendEmail: out.patch.sendEmail,
        addresses: out.patch.addresses,
        vars: out.patch.vars,
      })
    ) {
      log.warn('deploy: deploying without email.');
      return without;
    }
    configWritten = true;
  }
  const bindingPresent = shipsBinding || out.patch.sendEmail !== undefined;
  const written = out.patch.addresses ?? [];
  // `satisfied` is post-apply READINESS, not binding presence. `applyEmailSetup` writes
  // `patch.sendEmail` as soon as EITHER routing or sending came up, and withholds
  // `addresses` when the bearer failed or routing is off — so a run whose subdomain
  // routing POST failed ships the binding with no inbound rule behind it, which is
  // exactly the end state the `leaveAccount` branch above already returns as
  // `satisfied: false`. Gating `--require-email` on the binding alone would contradict
  // both that branch and the error text ("not fully set up … refusing to deploy"), so
  // this mirrors `preflightEmail`'s own `ready` predicate instead: the inbound rows
  // (routing + subaddressing, with `addresses` actually written — `out.inboundReady`, the
  // same field `void email setup` exits on) + the binding. The sending row needs no term
  // of its own: apply has just made its one `sending enable` call (or found the row ready
  // or blocked), and the binding it writes on that same run is what the NEXT preflight
  // reads as the memory of a refusal — binding present + sending pending is settled there
  // (Workers Free, `10105`; the memory rule in `preflightEmail`), so it is settled here,
  // or the two would disagree on the very next deploy. `map` stays on `bindingPresent`:
  // the worker DOES ship with email, and a deploy may ship with email while `satisfied`
  // is false.
  const satisfied = bindingPresent && out.inboundReady;
  return {
    satisfied,
    configWritten,
    map: bindingPresent
      ? mapFor(
          written,
          out.sendingReady,
          pre.rules.absent.filter((a) => written.includes(a)),
        )
      : null,
  };
}

/** The committed `addresses` entries that are still Void's pruned set (what wrangler keeps). */
function existingAddresses(
  rootConfig: Record<string, unknown>,
  pre: EmailPreflight,
): Array<string> {
  return Array.isArray(rootConfig.addresses)
    ? (rootConfig.addresses as Array<unknown>)
        .map((a) => (typeof a === 'string' ? a.toLowerCase() : ''))
        .filter((a) => pre.addresses.includes(a))
    : [];
}

/**
 * Ensure an auth-enabled worker has one persistent Better Auth secret.
 *
 * Existing remote secrets are adopted unchanged. A missing secret is generated
 * once, streamed to `wrangler secret put` over stdin (never argv), then verified
 * by listing names again. A not-yet-deployed Worker is the one safe list failure
 * treated as absence because Wrangler can attach a secret to its draft Worker.
 */
export async function ensureCloudflareAuthSecret(options: {
  root: string;
  configPath: string;
  accountId?: string;
  workerName: string;
  runWrangler: DeployWranglerRun;
  beforeWranglerRun?: () => boolean;
}): Promise<{ created: boolean; workerWasMissing?: true; candidateSecret?: string }> {
  let workerWasMissing = false;
  const beforeRun = (): void => {
    if (options.beforeWranglerRun && !options.beforeWranglerRun()) {
      throw new CloudflareAuthSecretError('', 'uploader-changed');
    }
  };
  const list = async (allowMissingWorker: boolean): Promise<Array<string>> => {
    beforeRun();
    try {
      return await listSelfHostSecretNames(
        {
          root: options.root,
          configPath: options.configPath,
          accountId: options.accountId,
          workerName: options.workerName,
          runWrangler: (args) => options.runWrangler(args, { capture: true }),
        },
        [BETTER_AUTH_SECRET_NAME],
      );
    } catch (error) {
      if (allowMissingWorker && error instanceof SelfHostFirstDeployError) {
        workerWasMissing = true;
        return [];
      }
      if (error instanceof SelfHostSecretListError) {
        throw new CloudflareAuthSecretError(
          `deploy: could not confirm the remote ${BETTER_AUTH_SECRET_NAME}. ` +
            'No worker was uploaded. Run `void secret list` to diagnose the Cloudflare response, then retry.',
          allowMissingWorker ? 'list-failed' : 'verification-failed',
        );
      }
      throw error;
    }
  };

  const existing = await list(true);
  if (existing.includes(BETTER_AUTH_SECRET_NAME)) {
    return { created: false };
  }

  const secret = randomBytes(32).toString('hex');
  if (workerWasMissing) {
    // cf uploads secrets with the initial Worker version. The API's standalone
    // secret endpoints reject a Worker that has not been created yet.
    return { created: true, workerWasMissing: true, candidateSecret: secret };
  }
  beforeRun();
  let put: DeployWranglerRunResult;
  try {
    put = await Promise.resolve(
      options.runWrangler(
        {
          type: 'secret.put',
          name: BETTER_AUTH_SECRET_NAME,
          configPath: options.configPath,
          workerName: options.workerName,
        },
        { capture: true, input: `${secret}\n` },
      ),
    );
  } catch {
    throw new CloudflareAuthSecretError(
      `deploy: could not create the remote ${BETTER_AUTH_SECRET_NAME}. ` +
        `No worker was uploaded. Run \`void secret put ${BETTER_AUTH_SECRET_NAME}\` and retry.`,
      'put-failed',
    );
  }
  if (!isCleanWranglerExit(put)) {
    throw new CloudflareAuthSecretError(
      `deploy: could not create the remote ${BETTER_AUTH_SECRET_NAME} ` +
        `(Cloudflare command exit ${String(put.status)}). No worker was uploaded. ` +
        `Run \`void secret put ${BETTER_AUTH_SECRET_NAME}\` and retry.`,
      'put-failed',
    );
  }

  const verified = await list(false);
  if (!verified.includes(BETTER_AUTH_SECRET_NAME)) {
    throw new CloudflareAuthSecretError(
      `deploy: Cloudflare reported success but ${BETTER_AUTH_SECRET_NAME} was not present afterward. ` +
        'No worker was uploaded; retry once Cloudflare secret storage is available.',
      'verification-failed',
    );
  }
  return { created: true, ...(workerWasMissing ? { workerWasMissing: true as const } : {}) };
}

/** Validate source-level native deploy inputs before account operations or project code. */
async function prepareCloudflareDeploySource(
  root: string,
  options: RunDeployOptions,
  voidConfig: VoidConfig,
) {
  // 0. Flag guard — `--skip-build` cannot be honored by this backend, so REJECT the
  // combination rather than silently ignore it. Every gate on this path reads the artifact
  // `vite build` emits as ground truth: the plaintext-var warnings, the required-secret gate
  // and the invalid-value gate all read the REAL `dist/ssr/wrangler.json`, and the auth check
  // reads the generated `.void/better-auth-schema.ts`. Skipping the build would leave them
  // validating a stale or absent artifact — i.e. reporting a worker that is not the one being
  // uploaded. Rejected here, before any account op, so the flag can never cost a build hook.
  if (options.skipBuild) {
    log.error(
      [
        'deploy: --skip-build is not supported with --platform cloudflare.',
        'This backend validates the artifact the build emits — the worker vars in',
        'dist/ssr/wrangler.json and the generated auth schema — so a skipped build would',
        'leave every check reading a stale or missing artifact instead of the worker you',
        'are about to upload. Drop --skip-build, or deploy with `void deploy` (the managed',
        'platform), which supports it.',
      ].join('\n'),
    );
    return null;
  }

  // Load the provision module ONCE, dynamically, so the sync deploy helpers can
  // reach its transport/drift/scrub primitives without a static import that would
  // make every managed `void deploy` eagerly load the provision lifecycle. Awaited
  // here BEFORE any sync helper that calls `requireProvisionModule()`.
  // 1. App-class narrowing — reject every artifact shape the current native
  // verifier cannot prove safe before any account, provision, or build op.
  let application: ApplicationAnalysis;
  try {
    application = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  } catch (error) {
    log.error(`deploy: ${getErrorMessage(error)}`);
    return null;
  }
  const classification = classifyCloudflareDeployApp(root, voidConfig, options, application);
  if (!classification.supported) {
    log.error(classification.reason);
    return null;
  }

  // 2. Desired resource set — computed ONCE from SOURCE, pre-build (fail-fast),
  // shared by the provision and drift paths. `authEnabled` / `migrationsDir` /
  // `dialect` drive the auth + migration gates below. The checked-in migrations are
  // deliberately NOT read here: the auth + migration gates re-collect them AFTER the
  // build (see step 8), because `vite build` runs arbitrary project plugins that could
  // add/rewrite migration SQL, and the remote apply reads the live post-build files.
  const configPath = discoverRootWranglerConfig(root);
  const facts = await computeDesiredCloudflareResources(root, voidConfig, configPath, application);
  const { desired, dialect, migrations: preBuildMigrations, migrationsDir } = facts;

  // 2a. External-database migrations are applied directly after every local gate
  // passes and immediately before the Worker upload. A checked-in migration therefore requires
  // the production DATABASE_URL in the deploy environment; the URL is also the source used when
  // provisioning a missing Hyperdrive config and is never serialized into the Worker artifact.
  if (dialect !== 'sqlite' && preBuildMigrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      [
        `deploy: ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations require DATABASE_URL for --platform cloudflare.`,
        'Set the production connection string in the deploy environment. Void uses it only to',
        'provision Hyperdrive and apply checked-in migrations before uploading the Worker; it is',
        'never written to wrangler.jsonc or the generated Worker config.',
      ].join('\n'),
    );
    return null;
  }

  // 2b. Validate Wrangler's migration glob before any account operation. Custom patterns are
  // supported, but they must follow Wrangler's migrations_dir prefix rule; the post-build gate
  // later enumerates the exact Minimatch result and requires byte-for-byte set and order parity
  // with Void's validated migrations before any remote D1 mutation.
  if (desired.d1) {
    const migrationsPattern = resolveWranglerMigrationPattern(
      parseRootWranglerConfig(configPath),
      desired.d1.binding,
      desired.d1.migrationsDir ?? relative(dirname(configPath), migrationsDir),
    );
    if (!migrationsPattern.ok) {
      log.error(migrationsPattern.reason);
      return null;
    }
  }

  return { configPath, ...facts };
}

/** Apply remote D1 changes and prove no migrations remain pending. */
async function applyAndVerifyRemoteD1Migrations(
  d1MigrateToken: string | undefined,
  configPath: string,
  runWrangler: DeployWranglerRun,
  assertUploaderStillPinned: () => boolean,
): Promise<boolean> {
  // 10. Apply pending migrations to remote D1 — AFTER all local + ground-truth gates pass, so a
  // failed gate never mutates remote D1. Uses the token resolved + validated at step 8d, and the
  // pinned root config (`-c`), which targets the account already verified by provision/drift.
  if (d1MigrateToken) {
    log.step('Applying D1 migrations...');
    // The local migration gates above ran project code (drizzle-kit loaded db/schema.ts), which
    // could have overwritten the hashed uploader bundle after the last check. Re-verify against the
    // pre-build baseline immediately before this credentialed, remote-mutating apply.
    if (!assertUploaderStillPinned()) {
      return false;
    }
    // 9a. Apply.
    const migrate = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.apply', database: d1MigrateToken, configPath },
        { capture: false },
      ),
    );
    if (!isCleanWranglerExit(migrate)) {
      log.error(
        `deploy: remote D1 migrations failed for "${d1MigrateToken}" (exit ${String(migrate.status)}). ` +
          'Fix the migration and rerun. Note: D1 always enforces foreign_keys=ON — a Drizzle ' +
          'table-rebuild using PRAGMA foreign_keys=OFF must use PRAGMA defer_foreign_keys instead.',
      );
      return false;
    }

    // Read the structured pending set after apply; a clean apply exit alone does not prove
    // the schema is current. Recheck integrity before this separate credentialed read.
    if (!assertUploaderStillPinned()) {
      return false;
    }
    const migrateList = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.list', database: d1MigrateToken, configPath },
        { capture: true },
      ),
    );
    if (!isCleanWranglerExit(migrateList)) {
      log.error(
        `deploy: could not verify the remote migration state for "${d1MigrateToken}" ` +
          `(\`d1 migrations list\` exit ${String(migrateList.status)}). Refusing to deploy against ` +
          'an unverified schema — rerun once wrangler can reach your account.',
      );
      return false;
    }
    const migrationState = migrateList.data as { pending?: unknown } | undefined;
    if (Array.isArray(migrationState?.pending) && migrationState.pending.length > 0) {
      log.error(
        [
          `deploy: remote D1 still has UNAPPLIED migrations for "${d1MigrateToken}" after apply.`,
          'The schema is not current for this deployment. Fix or apply the pending migrations, then retry.',
        ].join('\n'),
      );
      return false;
    }
    if (
      !Array.isArray(migrationState?.pending) ||
      !migrationState.pending.every((name) => typeof name === 'string')
    ) {
      log.error(
        [
          `deploy: could not confirm the remote migration state for "${d1MigrateToken}".`,
          'Cloudflare returned an invalid pending migration set. Refusing to deploy against an unverified schema.',
          'Retry once the database migration state can be read.',
        ].join('\n'),
      );
      return false;
    }
  }

  return true;
}

/** Check the built Worker against the pinned deployment target before upload. */
function verifyCloudflareDeployArtifact(
  root: string,
  deps: CloudflareDeployDeps,
  options: Parameters<typeof verifyGeneratedDeployConfig>[1],
): boolean {
  // 10. Verify the generated deploy config targets the pinned account + expected worker
  // AND the exact provisioned binding IDENTITIES BEFORE uploading. A `CLOUDFLARE_ENV` /
  // `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` the CF plugin loaded could have baked a
  // different account/name — or the SAME account/name with a flattened, DIFFERENT binding
  // set — into dist/ssr/wrangler.json; passing `desired` + the step-6 snapshots lets the check
  // reject a divergent binding set, not only an account/name mismatch. The comparison is against
  // the in-memory `bindingIdentitySnapshot` (NOT a post-build root re-read), so a build that
  // consistently rewrote both the root config and this artifact is still caught. The
  // `passthroughIdentitySnapshot` extends the same defense to the resource fields Void never emits
  // (`services` / `secrets_store_secrets` / …): an entry the build injected into one of them — or a
  // queue not in `desired.queues` — fails closed here too, before the credentialed upload binds it.
  const verification = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(root, options);
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
    return false;
  }

  return true;
}

/** Validate emitted Worker vars and required secrets against post-build ground truth. */
async function validateCloudflarePostBuildEnv(
  root: string,
  configPath: string,
  accountId: string,
  apiBaseUrl: string,
  workerName: string,
  schemaFacts: SelfHostSchemaFacts,
  authEnabled: boolean,
  existingWorker: ExistingCloudflareWorker | null,
  approvedHandoffKv: Array<ApprovedCloudflareKvBinding>,
  deps: CloudflareDeployDeps,
  assertUploaderStillPinned: () => boolean,
): Promise<boolean> {
  // 8. Post-build GROUND-TRUTH gates — validate the REAL artifact the build emitted, not a
  // facsimile. Read the actual `vars` the build baked into `dist/ssr/wrangler.json`, then
  // WARN (plaintext secret-looking vars) + GATE (required secrets, incl. INVALID values) +
  // auth-schema check + local migration gates, all against that ground truth. The only
  // project code that runs does so in the isolated `validate-emitted` probe (8b).
  const emitted = (deps.readEmittedWorkerVars ?? readEmittedWorkerVarsDefault)(root);
  if (existingWorker) {
    const generated = readGeneratedDeployConfig(root);
    assertExistingCloudflareConfig(existingWorker, generated.config, true, approvedHandoffKv);
  }
  if (!emitted.ok) {
    log.error(
      [
        'deploy: could not read the worker vars the build emitted — refusing to validate secrets.',
        `  ${emitted.reason}`,
        'The build must emit dist/ssr/wrangler.json for this backend. Rerun the build, or deploy',
        'this app with `void deploy` (the managed platform).',
      ].join('\n'),
    );
    return false;
  }
  const emittedVars = emitted.vars;
  // Better Auth's signing secret must never be baked into the generated config.
  // Match the managed Void deploy contract: the deploy target owns this secret
  // and stores it through its encrypted secret API, not through plaintext vars.
  if (authEnabled && Object.prototype.hasOwnProperty.call(emittedVars, BETTER_AUTH_SECRET_NAME)) {
    log.error(
      [
        `deploy: ${BETTER_AUTH_SECRET_NAME} must be stored as a Cloudflare Worker secret, not a plaintext worker var.`,
        'Remove it from Worker vars and rerun. This deploy command preserves an',
        'existing remote value or creates a persistent one automatically when it is missing.',
      ].join('\n'),
    );
    return false;
  }

  const plaintextServerKeys = schemaFacts.serverKeys.filter((key) => key in emittedVars);
  if (plaintextServerKeys.length > 0) {
    log.error(
      [
        'deploy: server env keys cannot ship as plaintext Worker vars:',
        ...plaintextServerKeys.map((key) => `  • ${key}`),
        'Remove them from Worker vars and set them with `void secret put <NAME>`.',
      ].join('\n'),
    );
    return false;
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
      return false;
    }
    if (validateResult.kind === 'schema-error') {
      log.error(`deploy: ${selfHostSchemaFailureMessage(validateResult.reason)}`);
      return false;
    }
    envContext.invalidKeys = validateResult.invalidKeys;
  }
  // The auth secret has its own deploy-owned lifecycle below. If an env schema
  // also declares it required, do not make the generic secret gate reject it
  // before the deploy has a chance to provision and verify it.
  if (authEnabled) {
    envContext.absentRequired = envContext.absentRequired.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
    envContext.invalidKeys = envContext.invalidKeys.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
  }
  // DISCHARGE the context. Reuses the same `dischargeSelfHostEnvContext` the unit tests
  // exercise — now fed the ground-truth vars + the real invalid-value set. It may spawn a
  // credentialed `wrangler secret list` (its own runner, via `createDefaultSecretListRunner`),
  // which runs the hashed uploader bundle — and the emitted-var validation above just ran project
  // code (env.ts) that could have overwritten it. Re-verify the uploader against the pre-build
  // baseline immediately before the spawn.
  if (!assertUploaderStillPinned()) {
    return false;
  }
  try {
    await (deps.dischargeSelfHostEnv ?? dischargeSelfHostEnvContext)(envContext, {
      root,
      configPath,
      accountId,
      // Pin the worker NAME too: the secret list resolves the worker from the config's
      // `name`, which the emitted-var probe above (project code) could have rewritten
      // since step 5 pinned it. The gate reconciles the config against this and fails
      // closed on a mismatch, mirroring the account pin.
      workerName,
    });
  } catch (err) {
    if (
      err instanceof SelfHostFirstDeployError ||
      err instanceof SelfHostSecretListError ||
      err instanceof SelfHostEnvValidationError ||
      err instanceof SelfHostSchemaError
    ) {
      log.error(err.message);
      return false;
    }
    throw err;
  }

  return true;
}

/** Deploy to the user's own Cloudflare account through the guarded native Worker flow. */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const initialCloudflareLink = readCloudflareLink(root);
  const initialCloudflareCandidate = readCloudflareCandidate(root);
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const voidConfig = readConfig(root);
  const atomic = options.atomic === true || voidConfig.deploy?.cloudflare?.mode === 'atomic';
  if (atomic && (options.reuseExistingWorker || initialCloudflareLink)) {
    log.error(
      'deploy: atomic deployment is unavailable during the existing Worker handoff. Complete the handoff first.',
    );
    return exit(1);
  }
  const detectedFramework = detectFramework(root);
  const frameworkPreset = detectedFramework ? FRAMEWORK_PRESETS[detectedFramework.name] : undefined;
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  // Static deploys branch before the full Worker classifier, so keep the
  // runtime-target guard ahead of both paths. An explicit Cloudflare deploy
  // must never reinterpret a node/bun/deno project as a Workers Assets app.
  if (isNodeTarget(voidConfig.target)) {
    log.error(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
    return exit(1);
  }

  if (detectedFramework?.class === 'a' && hasConfiguredVoidWorkerRoutingRules(voidConfig.routing)) {
    log.error(
      [
        `deploy: native Cloudflare deployment cannot apply Void routing redirects, rewrites, fallbacks, or headers to ${detectedFramework.name}.`,
        'This framework owns its Worker request handler, so these rules would otherwise be ignored.',
        'Move the rules into the framework or its Cloudflare Worker, then retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const provisionModule = await loadProvisionModule();
  const staticPreset =
    resolveCloudflareStaticPreset(root, voidConfig, options) ??
    (await resolveCloudflareVoidStaticPreset(root, voidConfig));
  if (staticPreset) {
    if (atomic) {
      log.error('deploy: atomic deployment is only for Workers with Durable Objects.');
      return exit(1);
    }
    return runCloudflareStaticDeploy(
      root,
      options,
      voidConfig,
      staticPreset,
      cliLog,
      deps,
      initialCloudflareLink,
      initialCloudflareCandidate,
    );
  }

  const source = await prepareCloudflareDeploySource(root, options, voidConfig);
  if (!source) {
    return exit(1);
  }
  const {
    configPath,
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir,
    migrations: preBuildMigrations,
    needsAI,
    aiBindingName,
    needsSandbox,
    needsLive,
    expectedCrons,
    needsEmail,
    emailHandlers,
  } = source;

  // (The auth-migration guard runs at 3d below, AFTER the transport + account pin, so it can
  // derive the Better Auth schema in an isolated subprocess under the build's EFFECTIVE mode +
  // the SAME scrubbed env the build uses — still BEFORE whoami / provision / build / deploy.)

  // 3. Preflight — pin ONE transport, pin the account, confirm wrangler auth. `rootConfig` is the
  // pre-probe ground truth the post-probe laundering guard (after 3c) compares against; the ONLY
  // re-parses are the account discovery's (3b) and the email step's (3b-ii), both of which write
  // BEFORE any project code runs.
  let rootConfig = parseRootWranglerConfig(configPath);
  if (needsSandbox) {
    try {
      assertSandboxNamespaceConfig(rootConfig, resolveSandboxConfig(voidConfig, root));
    } catch (error) {
      log.error(`deploy: ${getErrorMessage(error)}`);
      return exit(1);
    }
  }

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

  // Pin the bundled uploader before the first authenticated command, including
  // first-run account discovery. Every later credentialed invocation checks the
  // same baseline so project code can never swap the executable under the session.
  const hashUploader = deps.hashWranglerUploader ?? hashWranglerUploader;
  const wranglerUploaderHashBefore = hashUploader(root);
  const cfUploaderHashBefore =
    deps.activateVersion || deps.runWrangler ? undefined : hashCfUploader();
  const cfUploaderIsPinned = (): boolean => {
    const matched = cfUploaderHashBefore !== undefined && cfUploaderHashBefore === hashCfUploader();
    if (!matched) {
      log.error('deploy: refusing to run a changed cf uploader with Cloudflare credentials.');
    }
    return matched;
  };
  const assertUploaderStillPinned = (): boolean => {
    const check = assertWranglerUploaderUnchanged(wranglerUploaderHashBefore, hashUploader(root));
    if (check.ok) {
      return true;
    }
    log.error(
      [
        'deploy: refusing to run the Cloudflare uploader with your Cloudflare credentials.',
        check.reason,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return false;
  };

  // 3b. Pin the account. On an interactive first deploy Void authenticates,
  // selects the account, and persists it without exposing Wrangler as a user step.
  let accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    const accountRunner =
      deps.runWrangler ?? createDeployWranglerRunner(root, undefined, apiBaseUrl);
    try {
      accountId = await chooseCloudflareDeployAccount({
        persist: !(options.reuseExistingWorker || initialCloudflareLink),
        beforeWranglerRun: assertUploaderStillPinned,
        configPath,
        root,
        runWrangler: accountRunner,
      });
      rootConfig = parseRootWranglerConfig(configPath);
    } catch (error) {
      if (error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed') {
        return exit(1);
      }
      log.error(`deploy: ${getErrorMessage(error)}`);
      return exit(1);
    }
  }
  let workersDevSubdomain: string | undefined;
  try {
    workersDevSubdomain = resolveCloudflareWorkersDevSubdomain(root, accountId);
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  // The orchestrator's own wrangler runner — created here, after the account is pinned and before
  // the FIRST credentialed run of the email step below; shared by whoami / provision probes / migrate / deploy.
  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  // The worker name `wrangler deploy` uploads as: the root's `name`, else derived. Needed by the
  // email step (routing rules are matched to it) and reconciled into the root config at step 5.
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);

  // 3b-ii. Mode B email (design doc 0078) — detect, preflight, and with one Enter set up the
  // developer's own mail domain. Slotted AFTER the uploader hash (3b-i) and the account pin (3b), so its credentialed
  // wrangler runs execute the pinned bundle, and BEFORE the env-schema probe (3c), so no project
  // code has run when a credentialed call is made — and so `rootConfig` can simply be RE-PARSED
  // after the write: the post-probe laundering guard (the full-config `deepEqual` after 3c) then
  // sees `send_email` / `addresses` / `vars` as the pre-probe baseline and needs no exception.
  // Only `needsEmail` apps pay for it. The step stops every deploy for an ambiguous committed
  // subdomain plan waiting on DNS; otherwise `--require-email` turns every "deploying without
  // email" branch into an exit BEFORE anything is built or uploaded.
  let emailMap: EmailAddressMapInput | null = null;
  if (needsEmail) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const email = await runCloudflareEmailStep({
      root,
      configPath,
      voidConfig,
      rootConfig,
      handlers: emailHandlers,
      workerName,
      accountId,
      apiBaseUrl,
      runWrangler,
      nonInteractive: deps.isCI ?? isWranglerNonInteractiveOrCI(),
      confirm:
        deps.confirmEmailSetup ??
        (async (message) => {
          const answer = await confirm({ message, initialValue: true });
          return !isCancel(answer) && answer === true;
        }),
      fetchImpl: deps.emailFetch ?? fetch,
      dns: deps.emailDns ?? (await createNodeEmailDns()),
    });
    if (email.abortDeploy) {
      return exit(1);
    }
    if (options.requireEmail && !email.satisfied) {
      log.error(
        [
          'deploy: --require-email — email is not fully set up for this deploy (see above); refusing to deploy.',
          'Nothing was built or uploaded. Set email up, or drop --require-email.',
        ].join('\n'),
      );
      return exit(1);
    }
    if (email.configWritten) {
      rootConfig = parseRootWranglerConfig(configPath);
    }
    emailMap = email.map;
  } else {
    // The app stopped using email, but the root still carries what a Mode B deploy wrote.
    // wrangler keeps those rules pointed at a worker that no longer exports `email()`, so
    // inbound mail there fails with nothing in this output — say so. Warn only: deleting the
    // key would ORPHAN the live rules (wrangler skips the plan on `undefined`), and `[]` is
    // a destructive plan (a y/n in a TTY, a UserError after the upload in CI) — whether Void
    // should write it is a product call, not a deploy default (decision 11: never a failure).
    const staleAddresses = Array.isArray(rootConfig.addresses)
      ? (rootConfig.addresses as Array<unknown>).filter((a): a is string => typeof a === 'string')
      : [];
    const staleBinding =
      Array.isArray(rootConfig.send_email) &&
      (rootConfig.send_email as Array<{ name?: unknown } | null>).some(
        (e) => e?.name === SEND_EMAIL_BINDING,
      );
    if (staleAddresses.length > 0 || staleBinding) {
      log.warn(
        [
          'deploy: this app no longer declares email handlers or imports void/email, but the Cloudflare config still carries the email setup Void wrote:',
          ...staleAddresses.map(
            (a) =>
              `  • ${a} — still routed to worker "${workerName}", which no longer exports email(); inbound mail there will fail.`,
          ),
          ...(staleBinding ? [`  • send_email ${SEND_EMAIL_BINDING} binding`] : []),
          'Deploying as-is. To detach: remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in void.lock.json (and any authored overrides in void.config.ts), then delete the rules in the Cloudflare dashboard (Email → Email Routing → Routing rules).',
        ].join('\n'),
      );
    }
  }

  // 3c. Derive the env-INSENSITIVE server and required key names in an ISOLATED
  // SUBPROCESS under a scrubbed env. Importing the user's env.ts is arbitrary project
  // code, so it must not run in this credential-bearing parent. Run before provisioning/building so a
  // broken env.ts fails fast.
  const schemaProbeEnv = buildSchemaProbeEnv(accountId, apiBaseUrl);
  let schemaResult: EnvSchemaProbeResult;
  try {
    schemaResult = await (deps.resolveSchemaFacts ?? resolveEnvSchemaFactsDefault)(
      { root },
      schemaProbeEnv,
    );
  } catch (err) {
    log.error(`deploy: could not derive the env schema — ${getErrorMessage(err)}`);
    return exit(1);
  }
  if (schemaResult.kind === 'schema-error') {
    log.error(`deploy: ${selfHostSchemaFailureMessage(schemaResult.reason)}`);
    return exit(1);
  }
  const schemaFacts: SelfHostSchemaFacts = schemaResult.facts;

  // The schema probe above imports project code. Its child has no Cloudflare credentials, but it
  // can still rewrite files — including the root Wrangler config that every authenticated command
  // below consumes. Compare the full parsed config with the pre-probe value before `whoami` or the
  // provisioner gets a chance to run. This placement cleanly distinguishes an illicit probe write
  // from the provisioner's legitimate id/migrations_dir updates, so automatic provisioning does
  // not create a laundering exception. Formatting-only JSONC rewrites remain harmless because the
  // comparison is semantic and key-order-independent.
  if (!deepEqual(rootConfig, parseRootWranglerConfig(configPath))) {
    log.error(
      [
        'deploy: the root wrangler config changed during the pre-build env-schema probe.',
        'Refusing to run an authenticated Cloudflare command with a config rewritten by project',
        'code. Rebuild from a clean checkout, then rerun.',
      ].join('\n'),
    );
    return exit(1);
  }

  // 3e. Confirm wrangler auth. `whoami` gets the SAME `-c`/`--env=`/pinned-transport
  // context as migrate/deploy, so it authenticates against the exact endpoint they use.
  // Re-verify the uploader immediately before this credentialed run — the env-schema probe above
  // ran project code (env.ts) that could have overwritten the hashed bundle `whoami` executes.
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }
  try {
    await ensureCloudflareAuthentication({
      acceptApiToken: true,
      beforeRun: assertUploaderStillPinned,
      runWrangler: (operation, capture) => runWrangler(operation, { capture }),
      configPath: existsSync(configPath) ? configPath : undefined,
    });
  } catch (error) {
    if (error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed') {
      return exit(1);
    }
    log.error(`deploy: ${getErrorMessage(error)}`);
    return exit(1);
  }

  let existingWorker: ExistingCloudflareWorker | null = null;
  let pinnedHandoffLink: CloudflareLink | null = null;
  let approvedHandoffKv: Array<ApprovedCloudflareKvBinding> = [];
  if (options.reuseExistingWorker || initialCloudflareLink) {
    if (
      authEnabled ||
      needsSandbox ||
      needsAI ||
      expectedCrons.length ||
      desired.queues.length ||
      preBuildMigrations.length
    ) {
      throw new Error(
        'Link the existing site without adding runtime features, auth setup, or database migrations. Make those changes in a later deployment.',
      );
    }
    approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
    existingWorker = await prepareExistingCloudflareDeployWithAuth(
      {
        root,
        configPath,
        accountId,
        reuse: options.reuseExistingWorker,
        pinnedLink: initialCloudflareLink,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        approvedKv: approvedHandoffKv,
      },
      assertUploaderStillPinned,
    );
    pinnedHandoffLink = readCloudflareLink(root);
    if (!pinnedHandoffLink) {
      throw new Error('The pending Cloudflare handoff was not saved before deployment.');
    }
    rootConfig = parseRootWranglerConfig(configPath);

    // Resolve the cache choice now. The saved source setting applies to retries and
    // ordinary deploys, so completing the handoff never changes the app's cache policy.
    const isrNamespace = desired.kvNamespaces.find(
      (namespace) => namespace.binding === 'ISR_CACHE',
    );
    if (
      existingWorker &&
      !existingWorker.bindings.some((binding) => binding.name === 'ISR_CACHE') &&
      resolveBindingNames(voidConfig.inference?.bindings)?.kv !== 'ISR_CACHE' &&
      isrNamespace
    ) {
      const missing = provisionModule
        .checkCloudflareProvisionDrift(configPath, desired)
        .missing.filter((entry) => entry.binding !== 'ISR_CACHE');
      if (missing.length) {
        throw new Error(
          formatCloudflareDriftMessage(
            missing,
            reasons,
            'Linking cannot provision these inferred resources:',
            'Keep new application resources separate from this migration.',
          ),
        );
      }
      const enabled = await chooseCloudflareIsr(root, voidConfig, {
        interactive: !(deps.isCI ?? isWranglerNonInteractiveOrCI()),
        confirm: deps.confirmIsrSetup,
      });
      if (!enabled) {
        desired.kvNamespaces = desired.kvNamespaces.filter(
          (namespace) => namespace.binding !== 'ISR_CACHE',
        );
      } else {
        if (approvedHandoffKv.length === 0) {
          if (!assertUploaderStillPinned()) {
            return exit(1);
          }
          await (deps.provision ?? provisionModule.provisionCloudflareResources)(
            root,
            configPath,
            {
              kvNamespaces: [isrNamespace],
              queues: [],
            },
            {
              accountId,
              log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
            },
          );
          rootConfig = parseRootWranglerConfig(configPath);
          approvedHandoffKv = approvedCloudflareIsrBinding(voidConfig, rootConfig);
          if (approvedHandoffKv.length !== 1) {
            throw new Error(
              'ISR setup did not record a valid cache namespace. Rerun `void deploy` to retry.',
            );
          }
        }
        assertExistingCloudflareConfig(existingWorker, rootConfig, false, approvedHandoffKv);
      }
      cliLog.info('cloudflare_handoff_isr_choice', { enabled });
    }
  }

  // 3f. Sandbox is the one public Void feature whose native Cloudflare runtime has a hard
  // Workers Paid dependency: `void/sandbox` emits a Cloudflare Container application. Verify the
  // account entitlement + the active credential BEFORE provisioning any inferred resources or
  // running the project build. `containers list --json` is a read-only account probe and succeeds
  // even when the account has no existing containers. Its failure surface deliberately conflates
  // a missing Workers Paid entitlement with insufficient API-token permissions, so the diagnostic
  // explains both remedies instead of guessing from a 403. Apps that do not use Sandbox never run
  // this probe and retain a Workers Free-compatible deploy path.
  if (needsSandbox) {
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
    const containers = await Promise.resolve(
      runWrangler(
        { type: 'containers.list', configPath: existsSync(configPath) ? configPath : undefined },
        { capture: true },
      ),
    );
    if (!isCleanWranglerExit(containers)) {
      log.error(formatCloudflareSandboxUnavailable({ preflight: true }));
      return exit(1);
    }
    cliLog.info('cloudflare_sandbox_available');
  }

  // 4. Ensure every inferred resource exists. Missing id-bearing bindings trigger this
  // immediately; queues are probed below and trigger it when absent. `--provision` remains a
  // backwards-compatible force switch, but normal local and CI deploys need no extra command.
  // The provisioner is read-first and idempotent, and its local lock/config postconditions remain
  // the single authority for resource creation.
  const provisionAndVerify = async (): Promise<void> => {
    if (existingWorker) {
      const { missing } = provisionModule.checkCloudflareProvisionDrift(configPath, desired);
      throw new Error(
        missing.length > 0
          ? formatCloudflareDriftMessage(
              missing,
              reasons,
              'Linking cannot provision these inferred resources:',
              `Check the existing Worker's binding names and resource IDs in void.config.ts and inference.bindings there, then rerun \`void deploy\`. Keep new resources for a later deployment.`,
            )
          : 'Linking cannot provision resources. Remove --provision and rerun `void deploy` to reuse the existing Worker.',
      );
    }
    // Re-verify the uploader immediately before the credentialed provisioner, which runs
    // `wrangler <res> create` with the CF token. Nothing between `whoami` and here runs project
    // code, so this is defense-in-depth against the same probe-swap vector — against the one
    // pre-probe baseline, never re-baselined.
    if (!assertUploaderStillPinned()) {
      return exit(1);
    }
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
          'existing config), then rerun. Nothing was built or deployed — but provisioning runs',
          'before this check, so any resource listed as created above already exists in your',
          'account (rerunning adopts it rather than duplicating it).',
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
          'Retry `void deploy --platform cloudflare`, or provision the listed resources manually.',
        ),
      );
      return exit(1);
    }
    if (
      desired.d1 &&
      readStoredResourceName(
        parseRootWranglerConfig(configPath),
        'd1_databases',
        desired.d1.binding,
        'migrations_dir',
      ) !== desired.d1.migrationsDir
    ) {
      log.error(
        `deploy: provisioning did not set migrations_dir for D1 binding ${desired.d1.binding}. Retry \`void deploy --platform cloudflare\`.`,
      );
      return exit(1);
    }
  };

  const { missing: initiallyMissing } = provisionModule.checkCloudflareProvisionDrift(
    configPath,
    desired,
  );
  const d1NeedsConfigReconciliation =
    // A handoff applies no migrations, so preserve the existing local migration settings.
    // Reconciling migrations_dir must not send an already-bound database to the provisioner.
    !existingWorker &&
    desired.d1 != null &&
    readStoredResourceName(
      parseRootWranglerConfig(configPath),
      'd1_databases',
      desired.d1.binding,
      'migrations_dir',
    ) !== desired.d1.migrationsDir;
  if (options.provision || initiallyMissing.length > 0 || d1NeedsConfigReconciliation) {
    await provisionAndVerify();
  } else {
    // Queue names come from file paths (`queues/order/jobs.ts` → `order-jobs`, see
    // `queues/scan.ts`), and the probe below passes each one to wrangler as an ARGV positional.
    // Apart from joining path segments, names are not sanitized. Gate them on the SAME
    // `assertValidResourceName('queue', …)` the provisioner applies, BEFORE the probe runs:
    // a name beginning with `-` is
    // parsed by wrangler as a FLAG (`queues info --help` exits 0 printing usage), which the
    // probe would classify as inconclusive and wave through — silently forfeiting the
    // early-ordering guarantee this whole step exists to provide. Collect EVERY offending name
    // (as the drift/absent-queue errors do) so one rename pass clears them all.
    const invalidQueues = desired.queues.filter((name) => {
      try {
        provisionModule.assertValidResourceName('queue', name);
        return false;
      } catch {
        return true;
      }
    });
    if (invalidQueues.length > 0) {
      log.error(
        [
          'Deploy blocked — these queue names are not valid Cloudflare queue names:',
          ...invalidQueues.map((name) => `  • ${name} (queue)`),
          '',
          'A queue takes its name from its path in queues/; nested segments are joined with "-".',
          'A queue name must be 1–63 characters, contain only letters, digits and "-", and',
          'begin and end with a letter or digit.',
          '',
          'Rename the offending file(s) in queues/ and retry.',
        ].join('\n'),
      );
      return exit(1);
    }
    // The drift check above is config-only, and queues carry NO id in the config — so a
    // desired queue that was never created is invisible to it. `wrangler deploy` (step 11)
    // does reject a missing queue before uploading, but only AFTER the build (step 7) and
    // the remote D1 apply (step 9) have run. Probe each desired queue by name HERE so that
    // an absent queue can trigger the provisioner before either.
    //
    // `queues list` is unusable (a human table with no `--json`, whose single un-looped
    // page-1 request silently truncates on large accounts), so this is N `queues info`
    // calls — one clean binary probe per desired queue. Only the provisioner's exact,
    // name-aware not-found signal counts as absence: an inconclusive probe (auth or
    // network error, signal-killed child, unexpected output) must NOT block, since
    // `wrangler deploy`'s own pre-upload check still backstops it.
    const absentQueues: Array<string> = [];
    for (const name of desired.queues) {
      const info = await Promise.resolve(
        runWrangler({ type: 'queues.info', name, configPath }, { capture: true }),
      );
      if (provisionModule.isQueueConfirmedAbsent(info, name)) {
        absentQueues.push(name);
      }
    }
    if (absentQueues.length > 0) {
      await provisionAndVerify();
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
  // deploy the verified account. (`workerName` was resolved from the same root `name` before the
  // email step, which never touches it.)
  const frameworkQueues = detectedFramework ? source.analysis.queues : [];
  writeProvisionedWranglerConfig(
    root,
    {
      name: workerName,
      accountId,
      ...(detectedFramework
        ? {
            queues: {
              producers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                binding: queue.bindingName,
              })),
              consumers: frameworkQueues.map((queue) => ({
                queue: queue.name,
                ...(queue.maxBatchSize != null && { max_batch_size: queue.maxBatchSize }),
                ...(queue.maxBatchTimeout != null && {
                  max_batch_timeout: queue.maxBatchTimeout,
                }),
                ...(queue.maxRetries != null && { max_retries: queue.maxRetries }),
                ...(queue.retryDelay != null && { retry_delay: queue.retryDelay }),
              })),
              reconcileVoidOwned: true,
            },
          }
        : {}),
    },
    { configPath },
  );

  // 6. Pin the id-bearing binding IDENTITIES across the build, mirroring the account_id pin.
  // Provision (step 4) wrote each real id into the root config via `wrangler <res> create
  // --update-config`, and the reconcile above only touches `name`/`account_id` — so RE-READING
  // the config here captures exactly what every legitimate PRE-BUILD write persisted. The build
  // (step 7) runs untrusted project code with its Cloudflare credentials scrubbed, so a
  // compromised build dependency can only edit FILES: it could rewrite `wrangler.jsonc`'s
  // `d1_databases[<binding>].database_id` (keeping the binding + database_name) to redirect the
  // privileged remote D1 migrate (step 9) or the deploy (step 11) to a DIFFERENT same-account
  // resource — OR ADD a brand-new id-bearing binding (`EXTRA_DB`/`EXTRA_KV`/…) the CF plugin then
  // merges verbatim into the emitted artifact. So the snapshot captures EVERY id-bearing binding
  // declared here, not only the desired ones: the emitted-config check (step 10) rejects any
  // id-bearing binding in `dist/ssr/wrangler.json` absent from this pin, so a binding the build
  // added is caught while a user's own extra binding (present here) passes. This snapshot is the
  // ground truth the migrate assert (step 9) and the emitted-config check (step 10) compare
  // against. No legitimate path rewrites a binding id in the ROOT config after this point — the
  // CF plugin's only post-build id writes go to the emitted dist/ssr/wrangler.json, never back to
  // the root — so equality here is safe to assert.
  const preBuildRootConfig = parseRootWranglerConfig(configPath);
  const bindingIdentitySnapshot = snapshotBindingIdentities(preBuildRootConfig);
  // Companion pin taken from the SAME pre-build root config: the per-binding ENTRY per resource
  // field Void's own build never emits (`DEPLOY_PASSTHROUGH_ASSERT_FIELDS`). The emitted-config
  // check (step 10) rejects any such binding in `dist/ssr/wrangler.json` absent from this pin — or
  // one whose target it rewrote — so a build that INJECTS or RETARGETS a `services` /
  // `secrets_store_secrets` / `dispatch_namespaces` / `unsafe` / … binding is caught, while a
  // user's own hand-declared pass-through binding (present here, unchanged) passes. Void never
  // writes these fields, so no legitimate build adds one that was not already in the root.
  const passthroughIdentitySnapshot = snapshotPassthroughIdentities(preBuildRootConfig);
  // Companion RAW-value pin from the SAME pre-build root config for the fields the ENTRY pin cannot
  // cover: `unsafe` / `tail_consumers` / `streaming_tail_consumers` (whole-object-pinned — wrangler
  // applies `unsafe.metadata` LAST at upload and the tail consumers forward logs/requests; the pin
  // is symmetric, so removing a root-declared value is caught too), plus `durable_objects` (reject a
  // build-injected EXTERNAL DO `script_name`) and `ai` (pin the binding to the root's, or to Void's
  // own `{binding:'AI'}` only when `needsAI`). Void's build emits none of the first three.
  const passthroughRawFields = snapshotPassthroughRawFields(preBuildRootConfig);
  // Companion pin: the exact `containers` set Void's build emits — the root-declared containers
  // (spread verbatim) plus Void's own sandbox container when the source needs it (`needsSandbox`,
  // the SAME `isSandboxEnabled(config) || import-walk` signal index.ts gates emission on). A bare
  // `wrangler deploy` provisions a container application from this array, so the emitted-config
  // check (step 10) rejects a container the build injected, dropped, or retargeted.
  // `resolveSandboxConfig` is the SAME pure function the build uses, so the reconstructed sandbox
  // container is byte-identical to the emitted one.
  const expectedContainers = reconstructExpectedContainers(
    voidConfig,
    root,
    preBuildRootConfig,
    needsSandbox,
  );
  const expectedDurableObjectState = reconstructExpectedDurableObjectState(
    voidConfig,
    root,
    preBuildRootConfig,
    { needsSandbox, needsLive, analysis: source.analysis },
  );

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
  // `vite build` runs arbitrary project code — the user's config, every plugin, and env.ts
  // — and needs NO Cloudflare credential of its own (the CF plugin makes no authenticated
  // call from a build hook; Void's `remote: true` is a serve-only proxy to Void's own
  // platform, and build-time prerender/ISR runs on local Miniflare). So the build child gets
  // the same credential scrub as the probes, on the same rationale.
  //
  // Not a leak this can close: the CF plugin's `config` hook `loadEnv`s the project's own
  // `CLOUDFLARE_*` dotenv keys back into the child's `process.env`. Those values are already
  // on disk and readable by the build code either way — the scrub is about the credentials
  // the PARENT holds, which the project never had.
  const buildChildEnv = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Tell void:env to build Worker vars from portable production dotenv files
  // only. Outside this deploy path Vite keeps its standard dotenv behavior,
  // but local files cannot be serialized into the artifact this command uploads.
  requireProvisionModule().deleteEnvVarCaseAware(buildChildEnv, CLOUDFLARE_DEPLOY_BUILD_ENV);
  buildChildEnv[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  requireProvisionModule().deleteEnvVarCaseAware(
    buildChildEnv,
    CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  );
  if (existingWorker) {
    buildChildEnv[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV] = '1';
  }
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
      const command = frameworkPreset
        ? (voidConfig.inference?.build ?? resolveProjectCommand(root, frameworkPreset.buildCommand))
        : resolveProjectCommand(root, 'vite build');
      execSync(command, { cwd: root, stdio: 'inherit', env });
    });
  // The wrangler UPLOADER was pinned into `wranglerUploaderHashBefore` at the START of the deploy
  // (before the env-schema probe and the pre-build credentialed runs), and `assertUploaderStillPinned`
  // re-checks it against that ONE baseline before every credentialed spawn — never re-baselined. The
  // build below runs untrusted project code with the parent's Cloudflare creds scrubbed, so it can
  // only edit FILES — but that INCLUDES the `wrangler-dist` bundle every post-build credentialed
  // wrangler run (the secret list, the remote D1 migrate, and the deploy) executes — so re-verify
  // against the same baseline right after it, and again immediately before each spawn.
  try {
    runBuild(buildChildEnv);
  } catch (err) {
    log.error(`deploy: build failed — ${getErrorMessage(err)}`);
    return exit(getExitCode(err));
  }
  log.step('Preparing deployment...');
  if (detectedFramework && frameworkPreset) {
    try {
      await (deps.prepareFrameworkArtifact ?? prepareCloudflareFrameworkArtifact)(
        root,
        configPath,
        accountId,
        workerName,
        voidConfig,
        detectedFramework,
        frameworkPreset,
        schemaFacts.requiredKeys,
        needsAI ? { binding: aiBindingName } : undefined,
        existingWorker !== null,
      );
    } catch (error) {
      log.error(
        `deploy: could not prepare ${detectedFramework.name} for Cloudflare — ${getErrorMessage(error)}`,
      );
      return exit(1);
    }
  }
  // Early fail — re-check right after the build, before the ground-truth gates do any work. No
  // remote mutation has happened since the baseline was pinned, so a changed/unverifiable uploader
  // here leaves nothing half-done. Each credentialed spawn below re-checks again immediately.
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }

  // Re-collect the checked-in migrations from disk AFTER the build. `vite build` runs
  // arbitrary project plugins that could add or rewrite `db/migrations` SQL (or the
  // `migrations_dir` presence), and step 9's `wrangler d1 migrations apply` reads the
  // LIVE post-build files — so every migration that can reach remote D1 must be validated
  // against exactly what is on disk now, not a pre-build snapshot. This one set feeds both
  // the auth-schema check (8c) and the local migration gates (8d).
  const migrations = collectMigrations(migrationsDir);
  if (existingWorker && migrations.length) {
    throw new Error(
      'The build added database migrations. Link the existing site before making schema changes.',
    );
  }

  // A build plugin can add migrations after the pre-build source scan. Require the production URL
  // again against the post-build ground truth so no injected migration can be silently skipped.
  if (dialect !== 'sqlite' && migrations.length > 0 && !process.env.DATABASE_URL) {
    log.error(
      `deploy: the build added ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} migrations, but DATABASE_URL is not set. ` +
        'Refusing to upload a Worker against an unmigrated database.',
    );
    return exit(1);
  }

  // Wrangler Versions cannot apply a new Durable Object class migration to an existing Worker.
  // Inspect the active migration tag after the build has produced the exact config, but before
  // remote database migration or secret mutation. First deployments remain supported.
  const lifecycleConfigPath = (
    deps.resolveGeneratedConfigPath ??
    ((projectRoot) => readGeneratedDeployConfig(projectRoot).path)
  )(root);
  if (atomic && !Array.isArray(parseRootWranglerConfig(lifecycleConfigPath).migrations)) {
    log.error(
      'deploy: atomic deployment is only for Workers with Durable Object migration history.',
    );
    return exit(1);
  }
  try {
    deduplicateGeneratedCompatibilityFlags(lifecycleConfigPath, configPath);
    const lifecycleOptions = {
      runWrangler,
      configPath: lifecycleConfigPath,
      workerName,
      accountId,
      apiBaseUrl,
    };
    await (deps.assertDurableObjectLifecycle ?? assertCloudflareDurableObjectLifecycleSupported)({
      ...lifecycleOptions,
      allowPendingAtomicMigration: atomic,
    });
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  if (
    !(await validateCloudflarePostBuildEnv(
      root,
      configPath,
      accountId,
      apiBaseUrl,
      workerName,
      schemaFacts,
      authEnabled,
      existingWorker,
      approvedHandoffKv,
      deps,
      assertUploaderStillPinned,
    ))
  ) {
    return exit(1);
  }

  // 8c. Auth-schema check — the managed platform creates Void-managed Better Auth tables at
  // RUNTIME (POST /__void/migrate/auth) after dispatch; this self-host backend never calls it,
  // it only applies checked-in `db/migrations/*.sql`. So verify the checked-in migrations
  // PRODUCE the required Better Auth schema (tables + columns, incl. configured renames + plugin
  // tables) by reading the schema the BUILD generated (`.void/better-auth-schema.ts` — ground
  // truth) and applying the migrations to in-memory SQLite. PostgreSQL uses the same generated
  // schema as the drift gate below; applying its SQL to SQLite would be invalid, so only the D1
  // dialect needs this additional structural simulation.
  if (authEnabled && dialect === 'sqlite') {
    try {
      await (deps.validateAuthMigrations ?? validateAuthMigrationSchema)(root, migrations);
    } catch (err) {
      log.error(
        [
          'deploy: --platform cloudflare cannot verify the Void-managed Better Auth schema.',
          'The managed platform creates these tables at runtime (POST /__void/migrate/auth)',
          'after deploy; this self-host backend only applies checked-in db/migrations/*.sql, so',
          'they must already produce the Better Auth schema — tables, columns, and the primary',
          'keys, unique constraints and foreign keys it declares:',
          `  ${getErrorMessage(err)}`,
          ...(err instanceof SqliteMigrationError
            ? [
                'Repair the unapplied migration named above, then rerun deploy.',
                '`void db generate` diffs snapshots and cannot repair existing invalid SQL.',
              ]
            : [
                '`void db generate` includes the production Better Auth schema automatically.',
                'Run it, review and commit the generated migration, then rerun deploy.',
              ]),
        ].join('\n'),
      );
      return exit(1);
    }
  }

  // 8d. Local migration gates — run POST-build,
  // immediately before the remote apply, against the RE-COLLECTED post-build migrations. Moving
  // them here (from pre-build) closes the window where a build plugin could add/rewrite migration
  // SQL that step 9 would then apply to remote D1 ungated: `wrangler d1 migrations apply` reads
  // the live post-build files, and these gates now validate exactly that set. Nothing between the
  // build and here mutates remote state, so a failed gate never leaves a half-migrated account.
  let d1MigrateToken: string | undefined;
  if (desired.d1 || desired.hyperdrive) {
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

    // Resolve + validate the D1 migrate target ONLY when there ARE checked-in migrations: a D1
    // desired purely from DB-use or auth can have no `db/migrations`, and wrangler 4.131
    // HARD-FAILS `d1 migrations apply` on a missing/empty folder (it never no-ops).
    if (desired.d1 && migrations.length > 0) {
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
            'remote database, or error. Automatic provisioning should have set this field;',
            'rerun `void deploy --platform cloudflare`, or add it yourself.',
          ].join('\n'),
        );
        return exit(1);
      }
      // wrangler 4.131 resolves the migrate target by FIRST-matching the passed token
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

      // 8d-iii. Pin check — the remote apply below resolves its target from THIS post-build
      // `migrateConfig` (the root config wrangler re-reads to map the token → database_id), so
      // assert that database_id still equals what was snapshotted at step 6 BEFORE the build.
      // A tampered build that rewrote `d1_databases[<binding>].database_id` — keeping the binding
      // + database_name so the token still resolves — would otherwise redirect this privileged
      // `--remote` migration to a DIFFERENT same-account database. Fail closed, mirroring the
      // account_id pin. A binding never pinned (no real id pre-build, which the drift check
      // already rejects) is not asserted.
      const { field: d1Field, idField: d1IdField } = DEPLOY_BINDING_IDENTITY_FIELDS.d1;
      const pinnedD1Id = bindingIdentitySnapshot.get(
        bindingIdentityKey(d1Field, desired.d1.binding),
      );
      const postBuildD1Id = readStoredResourceName(
        migrateConfig,
        d1Field,
        desired.d1.binding,
        d1IdField,
      );
      if (pinnedD1Id !== undefined && postBuildD1Id !== pinnedD1Id) {
        log.error(
          [
            `deploy: the ${desired.d1.binding} D1 database identity changed between validation and the remote migrate.`,
            `Refusing to run \`wrangler d1 migrations apply\` — the build rewrote ${d1IdField} in ${configPath}`,
            `(validated ${JSON.stringify(pinnedD1Id)}, now ${JSON.stringify(postBuildD1Id)}), which would redirect this`,
            'privileged remote migration to a different database. Rebuild from a clean checkout, then rerun.',
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

  const generatedConfigPath = (
    deps.resolveGeneratedConfigPath ?? resolveGeneratedDeployConfigPathDefault
  )(root);
  const prepareBuildOutput = () =>
    frameworkPreset?.cloudflareArtifact === 'worker-output'
      ? prepareCfFrameworkBuildOutput({
          projectRoot: root,
          configPath: generatedConfigPath,
          accountId,
        })
      : prepareCfBuildOutput(dirname(generatedConfigPath), accountId);
  if (!deps.activateVersion && !deps.runWrangler) {
    // Validate the exact upload format before changing a remote database or secret.
    const preflight = await prepareBuildOutput();
    if (!preflight) {
      log.error('deploy: cf could not prepare the built Worker for deployment.');
      return exit(1);
    }
    await preflight.dispose();
  }

  // Remember whether a secret operation proved the Worker was absent before it wrote anything.
  // Wrangler creates an active placeholder version while attaching the first secret. The version
  // activator needs this proof to distinguish that placeholder from an existing application when
  // Cloudflare requires a one-time ordinary deploy for initial Durable Object migrations.
  let workerWasMissingBeforeSecretProvisioning = false;
  let initialAuthSecret: string | undefined;

  // 8e. Persistent Better Auth secret — after every local/build-derived gate,
  // but before the first remote migration or worker upload. Existing secrets
  // are adopted unchanged; a missing value is generated once, sent over stdin,
  // and verified by name before deployment can continue.
  if (authEnabled) {
    // Prove the artifact will inherit the secret BEFORE creating it. Wrangler
    // replaces Worker versions on deploy; without `secrets.required`, a secret
    // successfully written to the draft/current Worker can be dropped by the
    // immediately following upload.
    const inheritance = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(root, {
      accountId,
      workerName,
      desired,
      bindingIdentitySnapshot,
      passthroughIdentitySnapshot,
      passthroughRawFields,
      needsAI,
      aiBindingName,
      authEnabled,
      expectedContainers,
      expectedDurableObjectBindings: expectedDurableObjectState.bindings,
      expectedMigrations: expectedDurableObjectState.migrations,
      expectedCrons,
    });
    if (!inheritance.ok) {
      log.error(
        [
          'deploy: the generated deploy config cannot preserve the Better Auth secret — refusing to deploy.',
          inheritance.reason,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return exit(1);
    }
    try {
      const authSecret = await (deps.ensureAuthSecret ?? ensureCloudflareAuthSecret)({
        root,
        configPath,
        accountId,
        workerName,
        runWrangler,
        beforeWranglerRun: assertUploaderStillPinned,
      });
      workerWasMissingBeforeSecretProvisioning ||= authSecret.workerWasMissing === true;
      initialAuthSecret = authSecret.candidateSecret;
      cliLog.info('cloudflare_auth_secret_ready', { created: authSecret.created });
    } catch (error) {
      if (error instanceof CloudflareAuthSecretError && error.reason === 'uploader-changed') {
        return exit(1);
      }
      if (error instanceof CloudflareAuthSecretError) {
        log.error(error.message);
        return exit(1);
      }
      throw error;
    }
  }

  // 9. Apply pending PostgreSQL migrations transactionally before the Worker upload. The
  // production URL is intentionally provided by the deploy environment rather than recovered
  // from Hyperdrive (Cloudflare never returns the database password). `runPgMigrations` records
  // applied names in `_void_migrations`, so retries are idempotent.
  if (dialect === 'postgresql' && migrations.length > 0) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log.error('deploy: DATABASE_URL disappeared before PostgreSQL migrations could run.');
      return exit(1);
    }
    try {
      const applied = await (deps.applyPostgresMigrations ?? runPgMigrations)(
        migrationsDir,
        databaseUrl,
      );
      cliLog.info('cloudflare_postgres_migrations', { applied: applied.length });
      if (applied.length > 0) {
        log.success(
          `Applied ${applied.length} PostgreSQL migration${applied.length === 1 ? '' : 's'}.`,
        );
      }
    } catch (err) {
      log.error(`deploy: PostgreSQL migrations failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
  }

  if (dialect === 'mysql' && migrations.length > 0) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log.error('deploy: DATABASE_URL disappeared before MySQL migrations could run.');
      return exit(1);
    }
    try {
      const applied = await (deps.applyMySqlMigrations ?? runMySqlMigrations)(
        migrationsDir,
        databaseUrl,
      );
      cliLog.info('cloudflare_mysql_migrations', { applied: applied.length });
      if (applied.length > 0) {
        log.success(`Applied ${applied.length} MySQL migration${applied.length === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      log.error(`deploy: MySQL migrations failed — ${getErrorMessage(err)}`);
      return exit(1);
    }
  }

  if (
    !(await applyAndVerifyRemoteD1Migrations(
      d1MigrateToken,
      configPath,
      runWrangler,
      assertUploaderStillPinned,
    ))
  ) {
    return exit(1);
  }

  if (
    !verifyCloudflareDeployArtifact(root, deps, {
      accountId,
      workerName,
      desired,
      bindingIdentitySnapshot,
      passthroughIdentitySnapshot,
      passthroughRawFields,
      needsAI,
      aiBindingName,
      authEnabled,
      requiredSecretNames: schemaFacts.requiredKeys,
      expectedContainers,
      expectedDurableObjectBindings: expectedDurableObjectState.bindings,
      expectedMigrations: expectedDurableObjectState.migrations,
      expectedCrons,
    })
  ) {
    return exit(1);
  }

  // 11. Deploy the exact generated config verified above. Passing its absolute path
  // explicitly keeps the version upload AND the later trigger synchronization on the
  // same artifact. `versions upload` follows the deploy pointer on its own, but
  // `triggers deploy` does not; omitting `configPath` here would therefore upload the
  // generated cron/queue configuration and then synchronize triggers from the root
  // config, silently dropping generated Cron Triggers and queue consumers.
  // `--experimental-provision=false` / `--experimental-auto-create=false` disable
  // wrangler 4.131's OWN resource provisioning (both default true, deployCommand +
  // globalFlags, wrangler-dist/cli.js), so ONLY `provisionCloudflareResources` may create
  // resources — a bare deploy can never auto-create a missing binding (e.g. an R2 bucket
  // absent remotely but passing the local drift predicate), even in CI.
  // `--autoconfig=false` disables wrangler 4.131's framework detection + auto-config
  // (`autoconfig` defaults true, deployCommand cli.js:283108). Without it, a detected
  // framework marker (e.g. OpenNext) can make wrangler DELEGATE the deploy to another tool
  // (`maybeDelegateToOpenNextDeployCommand`, cli.js:282991) — which
  // would upload something OTHER than the artifact Void just built and verified. Forcing it
  // off guarantees wrangler uploads exactly the verified `dist/ssr/wrangler.json`.
  //
  // Final uploader re-verification immediately before the deploy — the last and most privileged
  // credentialed run of the hashed bundle. Against the same pre-build baseline; fail closed.
  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  if (existingWorker) {
    assertCloudflareLinkUnchanged(root, pinnedHandoffLink);
  }
  assertCloudflareCandidateUnchanged(root, initialCloudflareCandidate);
  if (
    initialCloudflareCandidate &&
    (initialCloudflareCandidate.accountId !== accountId ||
      initialCloudflareCandidate.workerName !== workerName)
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different account or Worker. Inspect its receipt before retrying.',
    );
  }
  const candidateReceipt = pinnedHandoffLink?.candidateReceipt;
  if (!deps.activateVersion && !deps.runWrangler && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = deps.activateVersion || deps.runWrangler ? null : await prepareBuildOutput();
  if (!cfOutput && !deps.activateVersion && !deps.runWrangler) {
    log.error('deploy: cf could not prepare the built Worker for deployment.');
    return exit(1);
  }
  const cfCommand = cfOutput
    ? createCfCommand({
        accountId,
        apiBaseUrl,
        env: deployChildEnv,
        verifyUploader: cfUploaderIsPinned,
      })
    : null;
  const activationRunner =
    cfOutput && cfCommand
      ? createCfVersionRunner({
          output: cfOutput,
          workerName,
          runCf: cfCommand,
          pinnedUpload: {
            accountId,
            apiBaseUrl,
            getToken: () => runWranglerAuthToken(runWrangler, generatedConfigPath),
            verifyUploader: cfUploaderIsPinned,
          },
          verifyResources: createCfResourceVerifier({
            configPath: generatedConfigPath,
            runCf: cfCommand,
            runWrangler,
            verifyCompatibilityRunner: assertUploaderStillPinned,
          }),
        })
      : runWrangler;
  const pinActiveSecrets = createActiveSecretPinner({
    output: cfOutput,
    handoffPending: pinnedHandoffLink !== null,
    requiredNames: schemaFacts.requiredKeys,
    ...(initialAuthSecret ? { explicitNames: [BETTER_AUTH_SECRET_NAME] } : {}),
  });
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      workerName,
      configPath: generatedConfigPath,
      preserveTriggers: existingWorker !== null,
      requireVersionMetadata:
        existingWorker === null ||
        readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) !== undefined,
      requirePreviewForReadiness:
        existingWorker !== null &&
        readVersionMetadataBinding(parseRootWranglerConfig(generatedConfigPath)) === undefined,
      expectedPreviousVersionId: existingWorker?.versionId,
      trustedInheritanceVersionIds: existingWorker
        ? candidateReceipt?.parentVersionId === existingWorker.versionId
          ? candidateReceipt.versionIds
          : undefined
        : initialCloudflareCandidate?.versionIds,
      validateUploadedVersion: existingWorker
        ? async (versionId) => {
            if (!assertUploaderStillPinned()) {
              throw new Error('The deployment uploader changed.');
            }
            const uploaded = await (deps.readExistingWorker ?? readExistingCloudflareWorker)({
              runWrangler,
              configPath: generatedConfigPath,
              workerName,
              versionId,
            });
            assertCloudflareBindingsPreserved(existingWorker, uploaded, approvedHandoffKv);
          }
        : undefined,
      recordVerifiedCandidate: existingWorker
        ? (versionId) =>
            recordCloudflareCandidate(root, pinnedHandoffLink!, existingWorker.versionId, versionId)
        : (versionId, parentVersionId) => {
            if (parentVersionId) {
              recordCloudflareCandidateUpload(
                root,
                initialCloudflareCandidate,
                accountId,
                workerName,
                parentVersionId,
                versionId,
              );
            }
          },
      message: encodeCloudflareVersionMessage(
        migrations.map((migration) => migration.name),
        {
          ...readCloudflareTriggerConfig(generatedConfigPath, configPath),
          ...(existingWorker ? { preserve: true } : {}),
        },
      ),
      allowFirstDeploymentBootstrap: workerWasMissingBeforeSecretProvisioning,
      readinessHeaders: cloudflareWorkerReadinessHeaders(),
      workersDevSubdomain,
      readinessHeadersWorkersDevSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim()
        ? workersDevSubdomain
        : undefined,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher({
        accountId,
        apiBaseUrl,
        configPath: generatedConfigPath,
        workerName,
        runWrangler,
      }),
      publishEmptyCrons: createCloudflareEmptyCronPublisher({
        accountId,
        apiBaseUrl,
        configPath: generatedConfigPath,
        workerName,
        runWrangler,
      }),
      previousTrafficConfig: readWranglerPublishedTrafficSnapshot(configPath),
      queueConsumerCleanup,
      verifyInheritedSecrets: true,
      ...(pinActiveSecrets ? { pinActiveSecrets } : {}),
      atomic,
      ...(initialAuthSecret
        ? { candidateSecrets: { [BETTER_AUTH_SECRET_NAME]: initialAuthSecret } }
        : {}),
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    if (
      execution.reason === 'atomic-readiness-failed' ||
      execution.reason === 'atomic-readiness-access-denied'
    ) {
      // The atomic command published successfully; the old inactive-candidate chain
      // no longer describes the live parent for the next deploy.
      clearCloudflareCandidate(root);
    }
    await reportCloudflareActivationFailure(
      cliLog,
      needsSandbox && execution.containersUnavailable
        ? formatCloudflareSandboxUnavailable()
        : formatCloudflareActivationError(execution),
    );
    return exit(1);
  }
  clearCloudflareCandidate(root);
  if (existingWorker) {
    completeCloudflareLink(root);
  }
  acknowledgeWranglerManagedQueueRemovals(configPath, queueConsumerCleanup);
  rememberCloudflareWorkersDevSubdomain(root, accountId, execution.previewUrl);
  if (execution.trafficConfig) {
    writeWranglerPublishedTrafficSnapshot(
      configPath,
      {
        workers_dev: execution.trafficConfig.workers_dev,
        preview_urls: execution.trafficConfig.preview_urls,
        routes: [...execution.trafficConfig.routes],
      },
      { create: false },
    );
  }
  cliLog.info('cloudflare_deploy_end', {
    ok: true,
    worker: workerName,
    versionId: execution.versionId,
  });
  log.success(`Deployed "${workerName}" to your Cloudflare account.\n${execution.previewUrl}`);
  // The address map — the one thing nobody can find today (0078). Printed whenever the worker
  // shipped with email set up; a run that went without email already said so at 3b-ii.
  if (emailMap) {
    log.message(renderAddressMap(emailMap));
  }
}

/**
 * Discover the root wrangler config path the same way the build / bindings
 * writer do (wrangler.jsonc first, then wrangler.json). Falls back to the
 * default wrangler.jsonc path when none exists yet — the provisioner creates it.
 */
export function discoverRootWranglerConfig(root: string): string {
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment needs one root wrangler.jsonc or wrangler.json with the same settings. Convert the config before deploying.',
    );
  }
  return materializeCloudflareConfig(root);
}

async function reportCloudflareActivationFailure(
  cliLog: CliLogger,
  message: string,
): Promise<void> {
  cliLog.error('cloudflare_deploy_failed', new Error(message));
  // The default exit() terminates the process immediately, so flush the diagnostic first.
  await cliLog.close().catch(() => {});
  log.error(`${message}${cliLog.path ? `\n\nDetailed log: ${cliLog.path}` : ''}`);
}

async function activateCloudflareVersionWithProgress(
  activate: typeof activateCloudflareVersion,
  options: Parameters<typeof activateCloudflareVersion>[0],
): ReturnType<typeof activateCloudflareVersion> {
  const progress = createSpinner();
  progress.start('Checking the current Worker deployment...');
  try {
    const result = await activate({
      ...options,
      onProgress: (message) => progress.message(message),
    });
    if (result.ok) {
      progress.stop('Worker version is ready.');
    } else {
      progress.error('Worker deployment stopped.');
    }
    return result;
  } catch (error) {
    progress.error('Worker deployment stopped.');
    throw error;
  }
}

export function formatCloudflareActivationError(
  result: Exclude<Awaited<ReturnType<typeof activateCloudflareVersion>>, { ok: true }>,
): string {
  const status = result.status === undefined ? '' : ` (exit ${String(result.status)})`;
  const cloudflareCode =
    result.cloudflareErrorCode === undefined
      ? ''
      : ` Cloudflare error code: ${String(result.cloudflareErrorCode)}.`;
  const diagnostic = result.diagnostic ? `\n\n${result.diagnostic}` : '';
  switch (result.reason) {
    case 'uploader-changed':
      if (result.rollback === 'succeeded') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Traffic was restored to the previous version.';
      }
      if (result.rollback === 'unavailable') {
        return 'deploy: the verified Wrangler uploader changed after the first version activated. No previous version is available; inspect `void project status` immediately.';
      }
      if (result.rollback === 'failed') {
        return 'deploy: the verified Wrangler uploader changed after version activation, and automatic traffic restoration failed. Inspect `void project status` immediately.';
      }
      if (result.rollback === 'unsafe') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Void did not invoke the changed binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
      }
      return 'deploy: the verified Wrangler uploader changed before version activation.';
    case 'status-failed':
      if (result.versionId) {
        return `deploy: Worker version ${result.versionId} was published, but current deployment status could not be verified${status}. Inspect \`void project status\` before retrying.`;
      }
      return `deploy: could not snapshot the current Cloudflare deployment${status}; no version was uploaded.`;
    case 'deployment-changed':
      return result.triggerRepair === 'succeeded'
        ? `deploy: another Cloudflare operation superseded this deployment. Void restored triggers for the active version ${result.activeVersionId ?? '(unknown)'}; retry from fresh deployment status.`
        : `deploy: another Cloudflare operation superseded this deployment, but its trigger state could not be verified. Inspect the active Worker version ${result.activeVersionId ?? '(unknown)'} immediately.`;
    case 'inheritance-source-unavailable':
      return 'deploy: could not verify which Worker Version would supply inherited secrets; production traffic is unchanged.';
    case 'inheritance-source-changed':
      return [
        'deploy: the active Worker Version is not the latest upload, and its secrets could not be pinned safely.',
        'Inspect the active and latest Worker versions in Cloudflare before retrying.',
        'No version was uploaded; production traffic is unchanged.',
      ].join('\n');
    case 'traffic-preservation-unavailable':
      return [
        'deploy: the existing Worker has dashboard-managed routes or visibility that Void cannot safely republish.',
        'Add its current routes, workers_dev, and preview_urls values to the root Wrangler config, then retry; no version was uploaded.',
      ].join('\n');
    case 'traffic-split-unsupported':
      return [
        'deploy: the current Cloudflare deployment splits traffic across multiple Worker Versions.',
        'Void will not flatten an existing gradual rollout to 100%. Finish or cancel that rollout',
        'in Cloudflare, then retry; no version was uploaded.',
      ].join('\n');
    case 'upload-failed':
      return `deploy: Cloudflare Worker Version upload failed${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}`;
    case 'upload-output-invalid':
      return 'deploy: Wrangler uploaded a version but did not report its version id; production traffic is unchanged.';
    case 'preview-unavailable':
      if (result.diagnostic) {
        return `deploy: candidate readiness cannot be verified.\n\n${result.diagnostic}`;
      }
      return [
        'deploy: the uploaded Worker Version has no preview URL, so Void cannot verify readiness.',
        'Set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain (for example "my-team")',
        'and retry. Void caches it after a successful workers.dev deployment; production traffic is unchanged.',
      ].join('\n');
    case 'readiness-staging-failed':
      return `deploy: Cloudflare could not stage the uploaded Worker Version at zero-percent traffic${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}${result.cloudflareErrorCode === 10210 && /Durable Object migration/i.test(result.diagnostic ?? '') ? '\n\nReview the Durable Object migration, then run `void deploy --platform cloudflare --atomic`. For future deploys, set deploy.cloudflare.mode to "atomic" in void.config.ts.' : ''}`;
    case 'atomic-failed':
      return `deploy: Cloudflare could not publish the Worker atomically${status}; inspect production status before retrying.${cloudflareCode}${diagnostic}`;
    case 'atomic-output-invalid':
      return 'deploy: Cloudflare published atomically but did not report a version id or URL. Inspect `void project status` immediately.';
    case 'atomic-readiness-failed':
    case 'atomic-readiness-access-denied':
      return `deploy: the atomic Worker deployment is live, but /__void/ready could not be verified. Inspect \`void project status\` and Worker logs immediately.${diagnostic}`;
    case 'readiness-failed':
      return [
        'deploy: the uploaded Worker Version did not pass /__void/ready.',
        formatCloudflareReadinessRestoration(result),
      ].join('\n');
    case 'readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the uploaded Worker Version readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token.',
        'For a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        `Then retry. ${formatCloudflareReadinessRestoration(result)}`,
      ].join('\n');
    case 'bootstrap-failed':
      return `deploy: Cloudflare could not bootstrap the first Worker deployment${status}.${cloudflareCode}${diagnostic}`;
    case 'bootstrap-output-invalid':
      return [
        'deploy: Cloudflare bootstrapped the first Worker deployment, but Wrangler',
        'did not report its version id and workers.dev URL. Inspect `void project status` before retrying.',
      ].join('\n');
    case 'bootstrap-readiness-failed':
      return (
        [
          'deploy: the first Worker deployment did not pass /__void/ready.',
          'Cloudflare requires this bootstrap to be non-versioned, so the new Worker is already active;',
          'inspect its logs and `void project status` before retrying.',
        ].join('\n') + diagnostic
      );
    case 'bootstrap-readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the first Worker deployment readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token;',
        'for a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        'Then retry. Cloudflare requires the first deployment to be non-versioned, so the new',
        'Worker is already active behind Access.',
      ].join('\n');
    case 'activation-failed':
      return `deploy: the ready Worker Version could not be activated${status}; production traffic is unchanged.`;
    case 'triggers-failed': {
      const rollback =
        result.rollback === 'succeeded'
          ? 'Traffic was restored to the previous version.'
          : result.rollback === 'unavailable'
            ? result.previousVersionId === null
              ? 'This was the first deployment, so no previous version was available to restore.'
              : 'Traffic or trigger restoration could not be completed. Inspect its routes, schedules, queues, and workflows in Cloudflare before retrying.'
            : 'Automatic traffic restoration failed; inspect `void project status` immediately.';
      return `deploy: the Worker activated, but Cloudflare trigger synchronization failed${status}. ${rollback}`;
    }
  }
}

function formatCloudflareReadinessRestoration(
  result: Exclude<Awaited<ReturnType<typeof activateCloudflareVersion>>, { ok: true }>,
): string {
  switch (result.rollback) {
    case 'succeeded':
      return 'The failed version remains inactive, and traffic was restored to the previous version.';
    case 'failed':
      return 'Automatic traffic restoration failed; inspect `void project status` immediately.';
    case 'unsafe':
      return 'Void did not invoke the changed Wrangler binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
    case 'unavailable':
      return 'No previous version was available to restore; inspect `void project status` immediately.';
    default:
      return 'The failed version remains inactive for inspection; production traffic is unchanged.';
  }
}

/** Capture the Access credential used only by the guarded Worker readiness probe. */
function cloudflareWorkerReadinessHeaders(): Record<string, string> {
  return trustedCloudflareWorkerAccessHeaders({
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
    CF_ACCESS_TOKEN: process.env.CF_ACCESS_TOKEN,
  });
}

/** Build the trusted Wrangler pointer for a framework that emits Worker files directly. */
export async function prepareCloudflareFrameworkArtifact(
  root: string,
  configPath: string,
  accountId: string,
  workerName: string,
  voidConfig: VoidConfig,
  framework: DetectedFramework,
  preset: FrameworkPreset,
  requiredSecretNames: ReadonlyArray<string> = [],
  ai?: { binding: string },
  preserveBindings = false,
): Promise<void> {
  const workerMain = join(root, preset.workerDir, preset.workerMain);
  const assetsDirectory = join(root, preset.assetsDir);
  if (!existsSync(workerMain)) {
    throw new Error(
      `framework ${framework.name} did not emit its Worker entry at ${preset.workerDir}/${preset.workerMain}`,
    );
  }
  if (!existsSync(assetsDirectory)) {
    throw new Error(
      `framework ${framework.name} did not emit its asset directory at ${preset.assetsDir}`,
    );
  }
  const analysis = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  const crons = analysis.jobs;
  const queues = analysis.queues;
  const revalidate = collectRevalidate(voidConfig, null);
  const rootConfig = parseRootWranglerConfig(configPath);
  const versionMetadataBinding = selectNativeVersionMetadataBinding(rootConfig, {
    nativeBuild: true,
    preserveBindings,
  });
  await generateDeployWrapperIfNeeded(root, join(root, preset.workerDir), preset.workerMain, {
    crons,
    queues,
    // Direct deployment applies migrations before upload; it does not need the
    // hosted platform's internal migration endpoint in its framework wrapper.
    hasMigrations: false,
    migrationDialect: analysis.dialect,
    readiness: true,
    versionMetadataBinding,
    ...(hasRevalidate(revalidate) && {
      isr: {
        revalidate: revalidate!,
        queryAllowlist: voidConfig.routing?.revalidateQueryAllowlist,
      },
    }),
  });
  if (preset.cloudflareArtifact === 'vite-plugin') {
    return;
  }
  writeCloudflareFrameworkDeployConfig({
    configPath,
    deployPointerPath: deployPointerPath(root),
    name: workerName,
    accountId,
    main: relative(dirname(configPath), workerMain),
    assetsDirectory: relative(dirname(configPath), assetsDirectory),
    compatibilityDate:
      voidConfig.worker?.compatibility_date ??
      readWranglerTopLevelString(rootConfig, 'compatibility_date') ??
      '2026-09-11',
    compatibilityFlags: preset.cloudflareCompatibilityFlags,
    crons: [...new Set(crons.flatMap((job) => job.crons))],
    requiredSecrets: requiredSecretNames,
    versionMetadataBinding,
    ...(ai ? { ai: { ...ai, gateway: voidConfig.ai?.gateway } } : {}),
    ...(preset.workerDir === preset.assetsDir
      ? {
          assetsIgnore: [
            preset.workerMain,
            '_routes.json',
            '__original.js',
            '__original.mjs',
            '__void_handlers.mjs',
            '__void_isr*.mjs',
            '__void_migration_handler*.mjs',
          ],
        }
      : {}),
  });
}

function resolveCloudflareStaticPreset(
  root: string,
  voidConfig: VoidConfig,
  options: Pick<RunDeployOptions, 'dir' | 'spa'>,
): StaticPreset | null {
  const configured = resolveStaticDeployPreset(root, voidConfig, options);
  if (configured) {
    return {
      ...configured,
      buildCommand: resolveStaticBuildCommand(
        configured,
        voidConfig.inference?.build,
        Boolean(options.dir),
      ),
    };
  }
  if (detectFramework(root)) {
    return null;
  }
  const detected = detectPreset(root, { spa: options.spa, strictBackend: true });
  return detected
    ? {
        ...detected,
        buildCommand: resolveStaticBuildCommand(detected, voidConfig.inference?.build, false),
      }
    : null;
}

/**
 * Resolve a Void Pages `output: "static"` app to the thin static edge worker
 * only when the same source-level conditions used by the managed deploy prove
 * that no request can require the application worker at runtime. Hybrid SSG
 * apps deliberately fall through to the normal Worker deploy path.
 */
export async function resolveCloudflareVoidStaticPreset(
  root: string,
  voidConfig: VoidConfig,
): Promise<StaticPreset | null> {
  if (voidConfig.output !== 'static') {
    return null;
  }

  const analysis = await analyzeApplication(root, { config: voidConfig, environment: 'prod' });
  const { paths, authEnabled, bindings, scan: routeScan } = analysis;
  if (!existsSync(paths.pagesDir) || validateSsrEntry(root, paths) !== null) {
    return null;
  }

  const pageScan = routeScan.pages;
  if (
    pageScan.pages.length === 0 ||
    !pageScan.pages.every(
      (page) =>
        page.shouldPrerender &&
        ((page.params.length === 0 && !page.catchAll) || page.hasGetPrerenderPaths),
    )
  ) {
    return null;
  }

  // The SAME predicate the managed path's fully-static optimization uses
  // (`hasNonPageBackend`), so the two static branches can never disagree on
  // whether an `email/` handler needs a worker: the thin static edge Worker
  // exports no `email()`, so inbound mail to a project routed there bounces.
  const hasRuntimeBackend =
    hasNonPageBackend({
      hasRoutes: routeScan.routes.length > 0,
      hasMiddleware: routeScan.middleware.length > 0,
      hasWebSockets: (routeScan.websockets?.length ?? 0) > 0,
      hasEmail: routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
      authEnabled,
      hasLive: bindings.needsLive === true,
    }) ||
    analysis.jobs.length > 0 ||
    analysis.queues.length > 0;
  if (hasRuntimeBackend) {
    return null;
  }

  return {
    buildCommand: resolveFullDeployBuildCommand(root, voidConfig.inference?.build).command,
    outputDir: join(root, 'dist', 'client'),
    appType: 'static',
  };
}

async function runCloudflareStaticDeploy(
  root: string,
  options: RunDeployOptions,
  voidConfig: VoidConfig,
  preset: StaticPreset,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps,
  initialCloudflareLink: CloudflareLink | null,
  initialCloudflareCandidate: CloudflareCandidateReceipt | null,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const configPath = discoverRootWranglerConfig(root);
  let rootConfig = parseRootWranglerConfig(configPath);
  let apiBaseUrl: string;
  try {
    apiBaseUrl = resolveDeployTransport(root, rootConfig);
  } catch (error) {
    log.error(`deploy: ${getErrorMessage(error)}`);
    return exit(1);
  }
  const hashUploader = deps.hashWranglerUploader ?? hashWranglerUploader;
  const uploaderHash = hashUploader(root);
  const cfUploaderHashBefore =
    deps.activateVersion || deps.runWrangler ? undefined : hashCfUploader();
  const cfUploaderIsPinned = (): boolean => {
    const matched = cfUploaderHashBefore !== undefined && cfUploaderHashBefore === hashCfUploader();
    if (!matched) {
      log.error('deploy: refusing to run a changed cf uploader with Cloudflare credentials.');
    }
    return matched;
  };
  const uploaderIsPinned = (): boolean => {
    const result = assertWranglerUploaderUnchanged(uploaderHash, hashUploader(root));
    if (!result.ok) {
      log.error(
        [
          'deploy: refusing to run the Cloudflare uploader with your Cloudflare credentials.',
          result.reason,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return result.ok;
  };
  let accountId =
    readWranglerTopLevelString(rootConfig, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    const accountRunner =
      deps.runWrangler ?? createDeployWranglerRunner(root, undefined, apiBaseUrl);
    try {
      accountId = await chooseCloudflareDeployAccount({
        persist: !(options.reuseExistingWorker || initialCloudflareLink),
        beforeWranglerRun: uploaderIsPinned,
        configPath,
        root,
        runWrangler: accountRunner,
      });
    } catch (error) {
      if (error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed') {
        return exit(1);
      }
      log.error(`deploy: ${getErrorMessage(error)}`);
      return exit(1);
    }
  }
  let workersDevSubdomain: string | undefined;
  try {
    workersDevSubdomain = resolveCloudflareWorkersDevSubdomain(root, accountId);
  } catch (error) {
    log.error(getErrorMessage(error));
    return exit(1);
  }

  const runWrangler = deps.runWrangler ?? createDeployWranglerRunner(root, accountId, apiBaseUrl);
  if (!uploaderIsPinned()) {
    return exit(1);
  }
  try {
    await ensureCloudflareAuthentication({
      acceptApiToken: true,
      beforeRun: uploaderIsPinned,
      runWrangler: (operation, capture) => runWrangler(operation, { capture }),
      configPath: existsSync(configPath) ? configPath : undefined,
    });
  } catch (error) {
    if (error instanceof CloudflareAuthenticationError && error.reason === 'uploader-changed') {
      return exit(1);
    }
    log.error(`deploy: ${getErrorMessage(error)}`);
    return exit(1);
  }

  const existingWorker = await prepareExistingCloudflareDeployWithAuth(
    {
      root,
      configPath,
      accountId,
      reuse: options.reuseExistingWorker,
      pinnedLink: initialCloudflareLink,
      runWrangler,
      readExistingWorker: deps.readExistingWorker,
    },
    uploaderIsPinned,
  );
  const pinnedHandoffLink = existingWorker ? readCloudflareLink(root) : null;
  if (existingWorker && !pinnedHandoffLink) {
    throw new Error('The pending Cloudflare handoff was not saved before deployment.');
  }
  rootConfig = parseRootWranglerConfig(configPath);
  const rootConfigBeforeBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (preset.buildCommand && !options.skipBuild) {
    log.step('Building...');
    const buildChildEnv = scrubManagedDeployBuildMarkers(
      scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
    );
    requireProvisionModule().deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
    buildChildEnv.NODE_ENV = 'production';
    const runStaticBuild =
      deps.runStaticBuild ??
      ((command: string, env: NodeJS.ProcessEnv) => {
        execSync(command, { cwd: root, stdio: 'inherit', env });
      });
    try {
      runStaticBuild(preset.buildCommand, buildChildEnv);
    } catch (error) {
      log.error(`deploy: build failed — ${getErrorMessage(error)}`);
      return exit(getExitCode(error));
    }
  }
  log.step('Preparing deployment...');
  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    return exit(1);
  }
  if (!uploaderIsPinned()) {
    return exit(1);
  }
  const rootConfigAfterBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (rootConfigAfterBuild !== rootConfigBeforeBuild) {
    log.error(
      [
        'deploy: the root Wrangler config changed during the static build.',
        'Refusing to upload a config rewritten by project build code. Restore the config and retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const merged = mergeRoutingRules({ dir: preset.outputDir, routing: voidConfig.routing });
  warnRedundantForceOn3xx(merged.redundantForceOn3xx);
  lintDuplicateSources(merged.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDuplicateSources(merged.fallbackRules, 'fallbacks (post-asset)');
  lintDestinationSplats(merged.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDestinationSplats(merged.fallbackRules, 'fallbacks (post-asset)');
  const manifest = buildStaticManifest({
    appType: preset.appType,
    hashedAssetsPrefix: 'assets',
    headerRules: merged.headerRules,
    redirectRules: merged.redirectRules,
    fallbackRules: merged.fallbackRules,
    notFound: voidConfig.routing?.notFound,
  });
  const entryPath = join(root, '.void', 'deploy', 'cloudflare', 'static-edge.mjs');
  mkdirSync(dirname(entryPath), { recursive: true });

  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  // Static deployment needs a fetch-only entry and must detach Worker-only
  // bindings/triggers, but those are deployment-artifact concerns. Preserve the
  // user's canonical Wrangler source byte-for-byte so switching back to the
  // Worker app does not lose hand-authored DOs, workflows, containers, queues,
  // or comments.
  const staticConfigPath = join(dirname(entryPath), 'wrangler-static.json');
  writeFileSync(staticConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`, { mode: 0o600 });
  writeCloudflareStaticDeployConfig({
    configPath: staticConfigPath,
    name: workerName,
    accountId,
    main: relative(dirname(staticConfigPath), entryPath),
    assetsDirectory: relative(dirname(staticConfigPath), preset.outputDir),
    compatibilityDate:
      voidConfig.worker?.compatibility_date ??
      readWranglerTopLevelString(rootConfig, 'compatibility_date') ??
      '2026-09-11',
    assetConfig: manifest.assetConfig ?? { not_found_handling: 'none' },
  });
  deduplicateGeneratedCompatibilityFlags(staticConfigPath, configPath);
  const staticConfig = parseRootWranglerConfig(staticConfigPath);
  const versionMetadataBinding = selectNativeVersionMetadataBinding(staticConfig, {
    nativeBuild: true,
    preserveBindings: existingWorker !== null,
  });
  if (versionMetadataBinding && staticConfig.version_metadata === undefined) {
    writeFileSync(
      staticConfigPath,
      `${JSON.stringify({ ...staticConfig, version_metadata: { binding: versionMetadataBinding } }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    entryPath,
    renderCloudflareStaticEntry({
      runtimeImport: 'void/edge',
      headerRules: manifest.headerRules,
      redirectRules: manifest.redirectRules,
      fallbackRules: manifest.fallbackRules,
      versionMetadataBinding,
    }),
  );

  if (existingWorker) {
    assertExistingCloudflareConfig(existingWorker, parseRootWranglerConfig(staticConfigPath), true);
  }

  const stagedAssetsDirectory = join(root, '.void', 'deploy', 'cloudflare', 'assets');
  stageCloudflareStaticAssets({
    sourceDirectory: preset.outputDir,
    destinationDirectory: stagedAssetsDirectory,
  });

  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  if (existingWorker) {
    assertCloudflareLinkUnchanged(root, pinnedHandoffLink);
  }
  assertCloudflareCandidateUnchanged(root, initialCloudflareCandidate);
  if (
    initialCloudflareCandidate &&
    (initialCloudflareCandidate.accountId !== accountId ||
      initialCloudflareCandidate.workerName !== workerName)
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different account or Worker. Inspect its receipt before retrying.',
    );
  }
  const candidateReceipt = pinnedHandoffLink?.candidateReceipt;
  if (!deps.activateVersion && !deps.runWrangler && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput =
    deps.activateVersion || deps.runWrangler
      ? null
      : await prepareCfStaticBuildOutput({
          projectRoot: root,
          configPath: staticConfigPath,
          assetsDirectory: stagedAssetsDirectory,
          accountId,
        });
  if (!cfOutput && !deps.activateVersion && !deps.runWrangler) {
    log.error('deploy: cf could not prepare the static Worker for deployment.');
    return exit(1);
  }
  const cfCommand = cfOutput
    ? createCfCommand({
        accountId,
        apiBaseUrl,
        env: deployChildEnv,
        verifyUploader: cfUploaderIsPinned,
      })
    : null;
  const activationRunner =
    cfOutput && cfCommand
      ? createCfVersionRunner({
          output: cfOutput,
          workerName,
          runCf: cfCommand,
          pinnedUpload: {
            accountId,
            apiBaseUrl,
            getToken: () => runWranglerAuthToken(runWrangler, staticConfigPath),
            verifyUploader: cfUploaderIsPinned,
          },
          verifyResources: createCfResourceVerifier({
            configPath: staticConfigPath,
            runCf: cfCommand,
            runWrangler,
            verifyCompatibilityRunner: uploaderIsPinned,
          }),
        })
      : runWrangler;
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : uploaderIsPinned,
      configPath: staticConfigPath,
      preserveTriggers: existingWorker !== null,
      requireVersionMetadata: existingWorker === null || versionMetadataBinding !== undefined,
      requirePreviewForReadiness: existingWorker !== null && versionMetadataBinding === undefined,
      expectedPreviousVersionId: existingWorker?.versionId,
      trustedInheritanceVersionIds: existingWorker
        ? candidateReceipt?.parentVersionId === existingWorker.versionId
          ? candidateReceipt.versionIds
          : undefined
        : initialCloudflareCandidate?.versionIds,
      validateUploadedVersion: existingWorker
        ? async (versionId) => {
            if (!uploaderIsPinned()) {
              throw new Error('The deployment uploader changed.');
            }
            const uploaded = await (deps.readExistingWorker ?? readExistingCloudflareWorker)({
              runWrangler,
              configPath: staticConfigPath,
              workerName,
              versionId,
            });
            assertCloudflareBindingsPreserved(existingWorker, uploaded, [], {
              staticAssetsBinding: 'ASSETS',
            });
          }
        : undefined,
      recordVerifiedCandidate: existingWorker
        ? (versionId) =>
            recordCloudflareCandidate(root, pinnedHandoffLink!, existingWorker.versionId, versionId)
        : (versionId, parentVersionId) => {
            if (parentVersionId) {
              recordCloudflareCandidateUpload(
                root,
                initialCloudflareCandidate,
                accountId,
                workerName,
                parentVersionId,
                versionId,
              );
            }
          },
      workerName,
      message: encodeCloudflareVersionMessage([], {
        ...readCloudflareTriggerConfig(staticConfigPath, configPath),
        ...(existingWorker ? { preserve: true } : {}),
      }),
      assetsDirectoryOverride: stagedAssetsDirectory,
      readinessHeaders: cloudflareWorkerReadinessHeaders(),
      workersDevSubdomain,
      readinessHeadersWorkersDevSubdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim()
        ? workersDevSubdomain
        : undefined,
      publishEmptyCustomDomains: createCloudflareEmptyDomainPublisher({
        accountId,
        apiBaseUrl,
        configPath: staticConfigPath,
        workerName,
        runWrangler,
      }),
      publishEmptyCrons: createCloudflareEmptyCronPublisher({
        accountId,
        apiBaseUrl,
        configPath: staticConfigPath,
        workerName,
        runWrangler,
      }),
      previousTrafficConfig: readWranglerPublishedTrafficSnapshot(configPath),
      queueConsumerCleanup,
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    await reportCloudflareActivationFailure(cliLog, formatCloudflareActivationError(execution));
    return exit(1);
  }
  clearCloudflareCandidate(root);
  if (existingWorker) {
    completeCloudflareLink(root);
  }
  acknowledgeWranglerManagedQueueRemovals(configPath, queueConsumerCleanup);
  rememberCloudflareWorkersDevSubdomain(root, accountId, execution.previewUrl);
  if (execution.trafficConfig) {
    writeWranglerPublishedTrafficSnapshot(
      configPath,
      {
        workers_dev: execution.trafficConfig.workers_dev,
        preview_urls: execution.trafficConfig.preview_urls,
        routes: [...execution.trafficConfig.routes],
      },
      { create: false },
    );
  }
  cliLog.info('cloudflare_deploy_end', {
    ok: true,
    worker: workerName,
    versionId: execution.versionId,
  });
  log.success(`Deployed "${workerName}" to your Cloudflare account.\n${execution.previewUrl}`);
}

type RunDeployTargetAdapter = DeployTargetAdapter<RunDeployOptions, CliLogger>;

const cloudflareDeployTarget: RunDeployTargetAdapter = {
  target: 'cloudflare',
  capabilities: {
    managedProjects: false,
    skipBuild: true,
    appTypes: {
      void: 'supported',
      spa: 'supported',
      static: 'supported',
      framework: 'supported',
    },
    features: {
      auth: 'supported',
      cron: 'supported',
      queues: 'supported',
      durableState: 'supported',
      webSockets: 'supported',
      live: 'supported',
      sandbox: 'supported',
      isr: 'supported',
      remoteDevelopment: 'unsupported',
      deploymentHistory: 'supported',
      rollback: 'supported',
      secrets: 'supported',
      domains: 'supported',
      logs: 'partial',
    },
  },
  async deploy(root, options, cliLog): Promise<void> {
    if (options.projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with platform cloudflare — this platform deploys to your own Cloudflare account and no Void project is involved.',
      );
    }
    assertInstalledVoidMatchesCli(root);
    if (migrateLegacyVoidConfig(root)) {
      log.success(
        'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
      );
    }
    return runCloudflareDeploy(root, options, cliLog);
  },
};

const voidDeployTarget: RunDeployTargetAdapter = {
  target: 'void',
  capabilities: {
    managedProjects: true,
    skipBuild: true,
    appTypes: {
      void: 'supported',
      spa: 'supported',
      static: 'supported',
      framework: 'supported',
    },
    features: {
      auth: 'supported',
      cron: 'supported',
      queues: 'supported',
      durableState: 'unsupported',
      webSockets: 'supported',
      live: 'supported',
      sandbox: 'supported',
      isr: 'supported',
      remoteDevelopment: 'supported',
      deploymentHistory: 'supported',
      rollback: 'supported',
      secrets: 'supported',
      domains: 'supported',
      logs: 'supported',
    },
  },
  deploy: runManagedDeploy,
};

const deployTargets: Record<DeployTarget, RunDeployTargetAdapter> = {
  cloudflare: cloudflareDeployTarget,
  void: voidDeployTarget,
};

async function runDeployInner(
  root: string,
  options: RunDeployOptions | undefined,
  cliLog: CliLogger,
): Promise<void> {
  // A missing field retains the historical Void behavior. New interactive
  // init runs always persist an explicit choice, with Cloudflare preselected.
  const link = await maybeLinkCloudflareDeploy(root, options);
  if (link === 'cancelled') {
    log.info('Deployment cancelled.');
    return;
  }
  if (link === 'existing') {
    options = { ...options, platform: 'cloudflare', reuseExistingWorker: true };
  }
  const platform = resolveDeploymentPlatform(root, options);
  if (options?.atomic && platform !== 'cloudflare') {
    throw new Error('deploy: --atomic is available only for Cloudflare Workers.');
  }

  if (platform === 'none') {
    throw new Error(
      'deploy: deployment setup was skipped during `void init`. Pass `--platform cloudflare` or `--platform void` to choose a destination.',
    );
  }

  const targetLabel = platform === 'cloudflare' ? 'Cloudflare' : 'Void';
  log.info(`Deployment target: ${targetLabel}`);
  cliLog.info('deploy_target', { target: platform });

  try {
    return await deployTargets[platform].deploy(root, options ?? {}, cliLog);
  } finally {
    if (existsSync(join(root, 'void.config.ts'))) {
      stashCloudflareDeployPointer(root);
    }
  }
}

async function runManagedDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
): Promise<void> {
  let reauthenticated = false;
  while (true) {
    try {
      // 1. Auth — resolve the deploy token by precedence:
      //   1. explicit `VOID_TOKEN` env  (deliberate override; wins everywhere)
      //   2. GitHub Actions OIDC exchange  (in Actions, when no explicit token)
      //   3. saved keychain / config file  (local dev)
      //
      // OIDC MUST beat an AMBIENT saved token here. `getToken()` returns the env
      // token AND a keychain/config-file token, so calling it unconditionally
      // first would let a leftover `void account login` credential on a self-hosted
      // / reused runner preempt OIDC. Only consult it before OIDC when the user
      // supplied an explicit env token; that still applies the shared origin
      // guard before any platform client can receive the credential. With no env
      // token, mint OIDC first and consult the saved credential only as fallback.
      let token = process.env.VOID_TOKEN ? getToken(root) : null;
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
        const tokenOrigin = getApiUrl(root);
        token = await exchangeGithubOidcForDeployToken(tokenOrigin, slug);
        maskGithubActionsSecret(token);
        // Keep source accounting and expired-token handling consistent with an
        // explicit CI token. `buildEnv()` always removes this value before any
        // project-controlled child starts; managed prerender obtains a separate
        // proxy-only token from the authenticated platform client.
        process.env.VOID_TOKEN = token;
        process.env.VOID_API_URL = tokenOrigin;
        cliLog.info('github_oidc_exchange_success', { slug });
      }
      // Local dev / non-Actions (or Actions without id-token permission): fall
      // back to the saved keychain/config token. `getToken()` re-checks
      // `VOID_TOKEN` first, which is harmlessly unset on this branch.
      token ??= getToken(root);
      if (!token) {
        log.error('No auth token found. Run `void account login` first.');
        process.exit(1);
      }

      const client = new PlatformClient(token, { root, cliLog });

      // The CF Access service-token pair is intentionally left in `process.env`
      // so interactive expired-token re-auth (below) can still read it. It is
      // kept OUT of every untrusted build child instead, via `buildEnv()` on the
      // spawn env — see that helper for the full rationale.

      // 2. Resolve target project (CLI flag > env var > linked project file)
      const requestedProjectSlug = getRequestedProjectSlug(options);
      const linkedProject = readProjectConfig(root);
      let config: ProjectConfig | null = null;

      if (requestedProjectSlug) {
        // Most deploys already have a project ID. The existing single-project
        // endpoint avoids account-wide history/traffic queries even when CI
        // also sets VOID_PROJECT to the linked slug.
        const linked =
          linkedProject?.slug === requestedProjectSlug
            ? await client.getProject(linkedProject.projectId)
            : null;
        const project =
          linked?.slug === requestedProjectSlug
            ? linked
            : await client.findProjectBySlug(requestedProjectSlug);
        assertProjectDeployAccess(project ?? undefined);
        config = project ? { projectId: project.id, slug: project.slug } : null;

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
        config = linkedProject;
        if (config) {
          const { projectId, slug } = config;
          const project = await client.getProject(projectId);
          if (!project) {
            throw new Error(
              `deploy: The linked project "${slug}" is unavailable or you no longer have access. ` +
                'Ask a project admin or owner to restore access, or choose another project with `--project <slug>`.',
            );
          }
          assertProjectDeployAccess(project);
        }
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

      if (migrateLegacyVoidConfig(root)) {
        log.success(
          'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
        );
      }

      // 3. Resolve deploy app type: void.config.ts > CLI flags > auto-detection
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
          process.env,
          // Same scrub as `getGitCommit` right above: these git children can
          // reach repo-configured hooks/credential helpers.
          buildEnv(),
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
            voidConfig,
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
        // `strictBackend` only here: this is the branch where the user has said
        // NOTHING about the app type, so an SSG project that also has a backend is
        // genuinely ambiguous and must be refused rather than silently deployed as
        // static. The explicit-intent paths (`--dir`, configured
        // `inference.appType`) resolve through `resolveStaticDeployPreset` above
        // and keep working without the guard.
        preset = detectPreset(root, { spa: options?.spa, strictBackend: true });
      }
      // appType === "void" or "framework" without a detected framework → full deploy.

      // Detect git commit before build (only when not skipping build)
      const gitMetadata = collectGitDeployMetadata(
        root,
        options?.skipBuild ? null : getGitCommit(root),
        process.env,
        buildEnv(),
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
          voidConfig,
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
          throw new Error('Auth token expired. Run `void account login` and try again.');
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

function assertProjectDeployAccess(project: ProjectResponse | undefined): void {
  // Older platforms omit roles; the API remains authoritative for every deploy.
  if (project?.role === 'reader') {
    throw new Error(
      `deploy: You have reader access to "${project.slug}" and cannot deploy. ` +
        'Ask a project admin or owner to grant collaborator access, or choose another project with `--project <slug>`.',
    );
  }
}

export async function promptDeployProjectConfig(
  root: string,
  client: PlatformClient,
  cliLog?: CliLogger,
): Promise<ProjectConfig> {
  const projects = await client.listProjectChoices();
  const deployableProjects = projects.filter((project) => project.role !== 'reader');
  if (deployableProjects.length !== projects.length) {
    log.warn(
      'Projects with reader access are hidden from deploy selection. Ask a project admin or owner to grant collaborator access to deploy to them.',
    );
  }
  const action = await promptProjectSetupAction('Set up a Void project for deploy:', {
    includeLink: deployableProjects.length > 0,
  });

  if (action === 'create') {
    return promptAndCreateProject(root, client);
  }

  // Project names are only shown after the user opts into linking.
  const result = await promptProjectSelection(
    deployableProjects,
    'Select a project to deploy to:',
    root,
    { confirmExisting: true, includeCreate: false },
  );

  if (result.action === 'create') {
    throw new Error('Unexpected project selection result.');
  }
  const config = { projectId: result.project.id, slug: result.project.slug };
  writeProjectConfig(root, attachSelectedPlatform(root, config, client.apiUrl));
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

/**
 * Resolve the build command for a FULL (Class A / Void app) deploy.
 *
 * `inference.build` wins when set, matching `runFrameworkDeploy` and the static
 * path's `resolveStaticBuildCommand`. Without it the full path was the only
 * deploy mode that ignored the config and hardcoded `vite build`, so an app that
 * needs more than one build step — an SSG that emits the site, then Void's build
 * packaging it via `publicDir` alongside the worker — had no way to express it
 * and died on the missing `index.html` entry.
 *
 * The two returned strings are deliberately different for the FALLBACK: `label`
 * goes to the user (`formatProjectCommand` rewrites `vite` → `vp` without
 * expanding an absolute bin path), `command` is what actually runs
 * (`resolveProjectCommand` expands to the local bin). A configured command is
 * the user's own text and is used verbatim for both, so what is printed is
 * exactly what is executed.
 */
export function resolveFullDeployBuildCommand(
  root: string,
  buildOverride?: string,
): { label: string; command: string } {
  if (buildOverride) {
    return { label: buildOverride, command: buildOverride };
  }
  return {
    label: formatProjectCommand(root, 'vite build'),
    command: resolveProjectCommand(root, 'vite build'),
  };
}

export type PrerenderSourceInputs = {
  /** `pages/` exists — file-based pages contribute static + `getPrerenderPaths()` paths. */
  hasPages: boolean;
  /** A custom SSR entry exists — it may export a top-level `getPrerenderPaths()`. */
  hasSsrEntry: boolean;
  /** `routing.prerender` from void.config.ts — compiled in as explicit paths. */
  explicitPrerenderPaths: ReadonlyArray<string> | undefined;
};

/**
 * Whether the built worker's `__voidCollectPrerenderPaths` can return anything
 * at all. When it cannot, booting it is pure cost and the deploy skips it.
 *
 * These three are exactly — and only — the sources `compilePrerenderCollector`
 * (`router/compile.ts`) emits a `paths.push(...)` for:
 *   1. `scan.pages.pages` — static patterns + dynamic pages' `getPrerenderPaths()`
 *   2. the custom SSR entry's top-level `getPrerenderPaths()` (`ssr` argument)
 *   3. `options.explicitPrerenderPaths` — void.config.ts `routing.prerender`
 * With none of them present the collector is a generated function whose body
 * returns `[...new Set([])]`, so skipping is result-identical.
 *
 * Skipping matters beyond speed. `collectPrerenderPaths` boots the worker in
 * Miniflare without remote production secrets, and the generated fetch handler
 * validates `env.ts` at boot. An app with nothing to prerender should not fail
 * merely because that unnecessary worker boot cannot access the remote store.
 */
export function hasPrerenderSources(inputs: PrerenderSourceInputs): boolean {
  return inputs.hasPages || inputs.hasSsrEntry || (inputs.explicitPrerenderPaths?.length ?? 0) > 0;
}

export type NonPageBackendInputs = {
  hasRoutes: boolean;
  hasMiddleware: boolean;
  hasWebSockets: boolean;
  hasEmail: boolean;
  authEnabled: boolean;
  hasLive: boolean;
};

/**
 * Whether the project needs a worker for something other than its pages.
 *
 * An `output: "static"` project whose pages all prerender takes the static-site
 * path, which uploads assets and NO worker script. Every worker surface that is
 * not a page has to be listed here, because a missing one is not a failed
 * deploy — it is a successful deploy with that feature silently absent.
 *
 * `email` belongs here for the same reason `hasRoutes` does: an `email/`
 * handler compiles to the worker's `email()` export (`router/compile.ts`), and
 * the platform dispatches inbound mail through that export. With no worker, the
 * mail bounces at the proxy with `project has no email handler`.
 *
 * Schedules and queues are deliberately NOT folded in. They are checked at the
 * call site against their own resolved lists, not against a scan flag.
 */
export function hasNonPageBackend(inputs: NonPageBackendInputs): boolean {
  return (
    inputs.hasRoutes ||
    inputs.hasMiddleware ||
    inputs.hasWebSockets ||
    inputs.hasEmail ||
    inputs.authEnabled ||
    inputs.hasLive
  );
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
    // Fully reused Worker/static assets need no bytes during finalization.
    assetFiles.clear();
    cliLog?.info('presign_skipped', { reason: 'no_needed_assets' });
  }

  // Build the JSON-mode payload. Worker bytes go in as base64 — the
  // manifest-only endpoint's design (0068) keeps worker bundles in the
  // body since they are bounded at 32 MiB total.
  let encodedWorkerFiles: Record<string, string> | undefined;
  if (workerFiles && workerFiles.size > 0) {
    encodedWorkerFiles = {};
    for (const [relPath, buf] of workerFiles) {
      encodedWorkerFiles[relPath] = buf.toString('base64');
    }
  }
  const artifact = createDeployArtifact({
    manifest,
    assetManifest,
    workerFiles: encodedWorkerFiles,
  });
  const payload: ManifestOnlyDeployPayload = createDeployUploadPayload(artifact, {
    source: getTokenSource(),
    commit: gitMetadata?.commit ?? null,
    repositoryUrl: gitMetadata?.repositoryUrl ?? null,
    commitUrl: gitMetadata?.commitUrl ?? null,
    gitRef: gitMetadata?.gitRef ?? null,
    preflight: preflightUsed ? 'true' : null,
  });

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
  isrEnabled = true,
): DeployManifest {
  return buildVoidManifest({
    ...opts,
    ...(isrEnabled ? {} : { revalidate: undefined, prerender: undefined }),
    // Bake each page's BUILD-time ISR TTL (3-state) from its own `export const
    // revalidate` first, then a global-NUMBER `routing.revalidate`. A page under
    // an OBJECT config bakes NO TTL (inherit-eligible) — see `collectPages`.
    pages: isFrameworkMode ? undefined : collectPages(pageScan, revalidateConfig, isrEnabled),
    // Ship the RAW per-path OBJECT config alongside so dispatch can resolve those
    // inherit-eligible pages against the ACTUAL request path (honoring per-path
    // `0` opt-outs a dynamic pattern straddles). Object form only: a number
    // config is already baked into every `pages` entry, so it is never consulted.
    pathRevalidate:
      !isrEnabled ||
      isFrameworkMode ||
      revalidateConfig == null ||
      typeof revalidateConfig !== 'object'
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
  /**
   * Explicit `routing.notFound`. Normally carried by `routing`, but the
   * "all pages prerendered -> static" redirect in `runFullDeploy` passes
   * `routing: undefined` (its rules were already merged upstream), so that
   * call site hands the value over directly. Wins over `routing.notFound`.
   */
  notFound?: NotFoundHandling,
): Promise<void> {
  const typeLabel = preset.appType === 'spa' ? 'Static SPA' : 'Static Site';
  log.info(`${typeLabel} deploy`);
  cliLog?.info('deploy_mode', { mode: 'static', appType: preset.appType });

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step('Building...');
    cliLog?.info('build_start', { command: preset.buildCommand });
    const buildStartedAt = Date.now();
    execSync(preset.buildCommand, {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv({ ...MANAGED_DEPLOY_BUILD_ENV }, { localBinRoot: root }),
    });
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
    notFound: notFound ?? routing?.notFound,
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
 * Class B/C framework deploys pin `not_found_handling: 'none'`, so
 * `routing.notFound` does nothing there — say so instead of dropping it
 * silently.
 *
 * These presets emit no `run_worker_first`, so Cloudflare's default applies and
 * the asset layer answers before the framework worker: real prerendered files
 * already win. `not_found_handling` only governs what the framework's own
 * `env.ASSETS.fetch()` delegation returns, which is framework-internal
 * plumbing. Honoring the override there would be a behavior change, not a fix —
 * `single-page-application` makes an unmatched delegation return
 * `dist/client/index.html` at **200** (Astro/SvelteKit hybrid builds commonly
 * prerender the root, so real 404s silently become the home page), and
 * `404-page` steals the 404 from the framework's own error route.
 *
 * Silenced when unset.
 */
export function warnIgnoredNotFoundForFramework(
  notFound: NotFoundHandling | undefined,
  frameworkName: string,
): void {
  if (notFound === undefined) {
    return;
  }
  log.warn(
    `"routing.notFound" in void.config.ts is ignored for ${frameworkName} deploys ` +
      `(not_found_handling is pinned to "none" — the framework's own worker owns unmatched HTML).`,
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

  // 1. Build
  const buildCmd = voidConfig.inference?.build ?? formatProjectCommand(root, fwPreset.buildCommand);
  if (!skipBuild) {
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    execSync(voidConfig.inference?.build ?? resolveProjectCommand(root, fwPreset.buildCommand), {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv({ ...MANAGED_DEPLOY_BUILD_ENV }, { localBinRoot: root }),
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

  // Merge framework-generated `_headers` / `_redirects` + void.config.ts routing rules.
  // Netlify-symmetric phases:
  //   - `_redirects` `200!` + routing.rewrites  → redirectRules (always-fires)
  //   - `_redirects` `200`  + routing.fallbacks → fallbackRules (asset-miss only)
  const { headerRules, redirectRules, fallbackRules, redundantForceOn3xx } = mergeRoutingRules({
    dir: assetsDir,
    routing: voidConfig.routing,
  });
  warnRedundantForceOn3xx(redundantForceOn3xx);

  // `assetConfig` below is pinned to `not_found_handling: 'none'` on this path,
  // so `routing.notFound` is inert. Warned here (outside the packaging spinner)
  // rather than at the pin itself.
  warnIgnoredNotFoundForFramework(voidConfig.routing?.notFound, detected.name);

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

  // Resolve the same application requirements consumed by build and native planning.
  const analysis = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  const { paths, bindings, authEnabled, dialect } = analysis;

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
  const rawMigrations = analysis.migrations;
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

  // Pre-deploy: ensure Hyperdrive is provisioned for external SQL projects.
  if (dialect !== 'sqlite' && analysis.needsDatabase) {
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
          message: `Your project uses ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'}. Enter your connection string:`,
          placeholder:
            dialect === 'mysql'
              ? 'mysql://user:pass@host:3306/dbname'
              : 'postgresql://user:pass@host:5432/dbname',
          validate(value) {
            const valid =
              dialect === 'mysql'
                ? value?.startsWith('mysql://')
                : value?.startsWith('postgres://') || value?.startsWith('postgresql://');
            if (!valid) {
              return dialect === 'mysql'
                ? 'Must start with "mysql://"'
                : 'Must start with "postgres://" or "postgresql://"';
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
  const rawJobs = analysis.jobs;
  const rawQueues = analysis.queues;
  const originalEntry = join(workerDir, fwPreset.workerMain);

  const wrapperFeatures: WrapperFeatures = {
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

  // 8. Read wrangler compat settings (void.config.ts > wrangler.jsonc > build output)
  // Use the original workerDir (not actualWorkerDir) because bundleEntry() may
  // reassign actualWorkerDir to a temporary output — the plugin-generated
  // wrangler.json with correct compat settings lives in the original build output.
  const wranglerCompat = resolveDeployWranglerCompat(root, voidConfig, workerDir, { dialect });

  // 9. Resolve revalidate + prerender from void.config.ts
  const revalidate = collectRevalidate(voidConfig, null);
  const prerender = voidConfig.routing?.isr === false ? undefined : voidConfig.routing?.prerender;

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

  // Production env values are remote secrets. Client values are compiled
  // from schema defaults or the build shell; no dotenv value enters the manifest.
  const envVars: Record<string, string> = {};

  // 10a. Validate against env.ts schema if present.
  await assertEnvSchemaValid(root, client, config.projectId);

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
    bindingNames: analysis.bindingNames,
    workerMain: actualWorkerMain,
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
    cpuMs: voidConfig.worker?.limits?.cpu_ms,
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
    // Pinned, NOT threaded from `routing.notFound` — see
    // `warnIgnoredNotFoundForFramework` for why the override must not apply to
    // Class B/C. The warning above tells the user when they set it anyway.
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

export function assertManagedDurableStateSupported(root: string): void {
  if (scanDurableObjectModules(root).length > 0) {
    throw new Error(
      'deploy: typed Durable State modules in durable-objects/ are not yet supported by the Void managed platform. Deploy to your own Cloudflare account with `void deploy --platform cloudflare`.',
    );
  }
}

async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  /**
   * The already-read `void.config.ts`, threaded from `runDeploy` the same way
   * `runFrameworkDeploy` receives it. The build step reads
   * `inference.build` from it, so it must be available BEFORE the build —
   * this used to be read further down as `deployConfig`, after the build had
   * already run with a hardcoded command.
   */
  voidConfig: VoidConfig,
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

  assertManagedDurableStateSupported(root);

  // 3. Build (child process to avoid Vite API side effects on bundle output)
  if (!skipBuild) {
    const { label: buildCmd, command: buildExec } = resolveFullDeployBuildCommand(
      root,
      voidConfig.inference?.build,
    );
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    try {
      // Pass VOID_DEPLOY_PROJECT_ID so plugin-prerender (running inside this
      // child vite build) can resolve the Void projectId without relying on
      // .void/project.json, which may be stale or absent under `--project <slug>`.
      execSync(buildExec, {
        cwd: root,
        stdio: 'inherit',
        env: buildEnv(
          { VOID_DEPLOY_PROJECT_ID: config.projectId, ...MANAGED_DEPLOY_BUILD_ENV },
          { localBinRoot: root },
        ),
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
  const workerDirName = resolveWorkerDirName(distDir, fwPreset, frameworkBuildCmd);

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
  const deployConfig = voidConfig;

  // Managed static prerender is deliberately outside the Vite subprocess. The
  // build runs arbitrary project plugins with every platform credential
  // scrubbed; only this trusted parent receives the proxy-only token and
  // injects it into the built worker's Miniflare bindings.
  if (deployConfig.output === 'static' && !isFrameworkMode) {
    const result = isNodeTarget(deployConfig.target)
      ? await prerenderPagesNode({
          root,
          ssrDir: join(distDir, 'ssr'),
          clientDir: join(distDir, 'client'),
        })
      : await prerenderPages({
          root,
          workerDir: join(distDir, workerDirName),
          clientDir: join(distDir, 'client'),
          persistDir: join(root, '.void'),
          remoteMode: resolveRemoteMode(deployConfig.remote),
          projectId: config.projectId,
          voidToken: await client.createPrerenderToken(config.projectId),
        });

    if (result.paths.length === 0) {
      log.info('No pages to prerender');
    } else if (result.failed.length > 0) {
      voidWarn(`${result.failed.length} page(s) failed to prerender`);
    }
  }

  const analysis = await analyzeApplication(root, { config: deployConfig, environment: 'prod' });
  const { paths, dialect, bindings, authEnabled, scan: routeScan } = analysis;
  const effectiveBindings = bindings;

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
  // `void.config.ts` routing rules. See the framework branch above for phase splitting.
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
  const rawMigrations = analysis.migrations;
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

  // Pre-deploy: ensure Hyperdrive is provisioned for external SQL projects.
  // Migrations on disk also gate this — even if inference says needsD1: false,
  // buildVoidManifest will add the hyperdrive binding when migrations are present.
  if (dialect !== 'sqlite' && analysis.needsDatabase) {
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
          message: `Your project uses ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'}. Enter your connection string:`,
          placeholder:
            dialect === 'mysql'
              ? 'mysql://user:pass@host:3306/dbname'
              : 'postgresql://user:pass@host:5432/dbname',
          validate(value) {
            const valid =
              dialect === 'mysql'
                ? value?.startsWith('mysql://')
                : value?.startsWith('postgres://') || value?.startsWith('postgresql://');
            if (!valid) {
              return dialect === 'mysql'
                ? 'Must start with "mysql://"'
                : 'Must start with "postgres://" or "postgresql://"';
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
  const rawJobs = analysis.jobs;
  const rawQueues = analysis.queues;
  const schedules = rawJobs.flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const webSockets = analysis.websockets;
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
  // Kept lazy behind `isFrameworkMode` exactly as the inline call was: a Class-A
  // framework app has no Void SSR entry to validate.
  const ssrEntry = isFrameworkMode ? null : validateSsrEntry(root, paths);
  const isSsr = isFrameworkMode
    ? true
    : Boolean(ssrEntry) || (hasPages && deployConfig.output !== 'static');

  // Resolve revalidate config from void.config.ts + per-page .server.ts exports.
  // The page scan is also reused by the fully-static optimization below.
  const pageScan = hasPages ? routeScan.pages : null;
  const revalidate = collectRevalidate(deployConfig, pageScan);

  // Fully-static optimization: if output: "static" and all pages are prerendered
  // with no backend features, deploy as a static site (no worker needed)
  if (deployConfig.output === 'static' && pageScan && !isSsr) {
    const allPrerenderable = pageScan.pages.every(
      (p) =>
        p.shouldPrerender && ((p.params.length === 0 && !p.catchAll) || p.hasGetPrerenderPaths),
    );
    const nonPageBackend = hasNonPageBackend({
      hasRoutes,
      hasMiddleware,
      hasWebSockets,
      hasEmail: routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
      authEnabled,
      hasLive: liveConfig !== undefined,
    });
    if (allPrerenderable && !nonPageBackend && schedules.length === 0 && queues.length === 0) {
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
        // Rules were already merged above — pass only the notFound override.
        undefined,
        cliLog,
        deployConfig.routing?.notFound,
      );
    }
  }

  // Resolve prerender paths. Skip in three cases:
  //   - output: "static" — pages are already built as static assets.
  //   - framework mode (Class A) — the framework's own worker entry has no
  //     /__void/prerender-paths endpoint (only compileWorkerEntry /
  //     compileNodeApp emit it for Void apps). Class-A frameworks handle
  //     prerendering through their own build pipelines.
  //   - the app has no prerender source at all (no `pages/`, no SSR entry, no
  //     `routing.prerender`) — the collector provably returns `[]`, so booting
  //     the worker in Miniflare can only fail, never contribute. See
  //     `hasPrerenderSources` for why that failure mode matters.
  const prerenderSourcesPresent = hasPrerenderSources({
    hasPages,
    hasSsrEntry: ssrEntry !== null,
    explicitPrerenderPaths: deployConfig.routing?.prerender,
  });
  const uniquePrerenderPaths =
    deployConfig.routing?.isr === false ||
    deployConfig.output === 'static' ||
    isFrameworkMode ||
    !prerenderSourcesPresent
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
            voidToken: await client.createPrerenderToken(config.projectId),
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

  // Production env values are remote secrets; dotenv is local-only.
  const envVars: Record<string, string> = {};

  // 9a. Validate against env.ts schema if present.
  await assertEnvSchemaValid(root, client, config.projectId);

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
    notFound: deployConfig.routing?.notFound,
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
    cpuMs: deployConfig.worker?.limits?.cpu_ms,
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
      hasEmailHandlers:
        !isFrameworkMode && routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
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
    deployConfig.routing?.isr !== false,
  );
  const workerDir = join(distDir, workerDirName);
  if (isFrameworkMode) {
    const wrapperFeatures: WrapperFeatures = {
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
  writeProjectConfig(root, attachSelectedPlatform(root, config, client.apiUrl));
  log.success(`Project created: ${pc.blue(config.slug)}`);
  reportProjectCreationWarnings(project);
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
  const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (!discoverSchema(root, readProjectPaths(root)) && !existsSync(authSchemaPath)) {
    return false;
  }

  const driftRoot = mkDeployDriftCheckRoot(root);
  const driftProjectRoot = join(driftRoot, 'project');

  createDeployDriftProject(root, driftProjectRoot);

  try {
    const migrationsDir = readProjectPaths(driftProjectRoot).migrationsDir;
    const before = snapshotDir(migrationsDir);
    const driftAuthSchemaPath = join(driftProjectRoot, '.void', 'better-auth-schema.ts');
    const driftConfigPath = writeDrizzleConfig(
      driftProjectRoot,
      dialect === 'postgresql'
        ? 'postgresql://dummy'
        : dialect === 'mysql'
          ? 'mysql://dummy'
          : ':memory:',
      dialect,
      {
        additionalSchemas: existsSync(driftAuthSchemaPath) ? [driftAuthSchemaPath] : undefined,
      },
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
    // CF Access service token AND every wrangler-auth credential out of it, matching the
    // build spawns. Generating migrations needs no Cloudflare credential.
    env: scrubWranglerAuthCredentials(buildEnv()),
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

  // The build-generated Better Auth schema participates in `void db generate`, so
  // it must also participate in the isolated drift check. Copy only this known
  // generated input; the rest of `.void` remains excluded as before.
  const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (existsSync(authSchemaPath)) {
    const target = join(driftProjectRoot, '.void', 'better-auth-schema.ts');
    mkdirSync(dirname(target), { recursive: true });
    cpSync(authSchemaPath, target);
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
      'Upload missing server values with `void secret put <NAME>`; set VITE_* values in the build shell or schema defaults.',
    );
  }
  throw new DeployEventError('deploy: Aborting because env.ts schema is not satisfied.');
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
