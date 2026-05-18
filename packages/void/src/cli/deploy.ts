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
import { join, relative, resolve } from 'pathe';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const deployDriftCheckDir = join('.void', 'deploy-drift-check');
import { intro, outro, log, note, confirm, isCancel, type SpinnerResult } from '@clack/prompts';
import {
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetConfig,
} from '../asset-routing.ts';
import { findVoidAuthConfig } from '../auth/config.ts';
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
import { voidWarn } from '../log.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { scanPages } from '../pages/scan.ts';
import {
  inferProjectBindings,
  FRAMEWORK_SCAN_DIRS,
  detectFramework,
  type DetectedFramework,
} from '../plugin-inference.ts';
import { collectPrerenderPaths, collectPrerenderPathsNode } from '../prerender.ts';
import { scanQueuesSync } from '../queues/scan.ts';
import { scanRoutes } from '../router/scan.ts';
import { scanWebSocketRoutesSync } from '../router/websocket.ts';
import {
  isSandboxEnabled,
  requiresSandboxPlatformImage,
  resolveSandboxConfig,
} from '../sandbox/config.ts';
import { resolveRemoteMode, stripInternalEnvKeys } from '../shared/env.ts';
import { validateSsrEntry } from '../ssr/entry.ts';
import { getToken, getTokenSource } from './auth.ts';
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
import {
  fetchRemoteSecretNames,
  formatEnvReport,
  getDeployEnvDefaults,
  validateProdEnv,
} from './env-validation.ts';
import { collectGitDeployMetadata, type GitDeployMetadata } from './git-metadata.ts';
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
  FRAMEWORK_PRESETS,
  formatProjectCommand,
  resolveProjectCommand,
  type StaticPreset,
  type FrameworkPreset,
} from './preset.ts';
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from './project.ts';
import { promptProjectSelection, promptProjectSetupAction } from './prompt.ts';
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
};

type DeployDoneEvent = Extract<DeployEvent, { event: 'done' }>;
type StreamDeployResult = DeployDoneEvent;

type ResourceSummary = {
  type?: string;
};

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

async function runDeployInner(
  root: string,
  options: RunDeployOptions | undefined,
  cliLog: CliLogger,
): Promise<void> {
  let reauthenticated = false;
  while (true) {
    try {
      // 1. Auth
      const token = getToken(root);
      if (!token) {
        log.error('No auth token found. Run `void auth login` first.');
        process.exit(1);
      }

      const client = new PlatformClient(token, { root, cliLog });

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

      // Check for known framework first
      const detected = detectFramework(root);
      if (detected) {
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

      let preset: StaticPreset | null = null;

      const appType = voidConfig.inference?.appType;
      if (appType && appType !== 'void' && appType !== 'framework') {
        // void.json has an explicit static app type
        const outputDir = voidConfig.inference?.outputDir;
        preset = {
          buildCommand: null,
          outputDir: outputDir ? resolve(root, outputDir) : join(root, 'dist'),
          appType,
        };
        // Re-detect build command (config stores app type, not command)
        const detectedPreset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
        if (detectedPreset) {
          preset.buildCommand = detectedPreset.buildCommand;
          if (!outputDir) {
            preset.outputDir = detectedPreset.outputDir;
          }
        }
      } else if (!appType) {
        // No configured app type — detect from CLI flags + project structure
        preset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
      }
      // appType === "void" or "framework" → preset stays null → full deploy

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
      s.stop('Deployed!');
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
async function streamDeployEvents(
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
        cliLog?.info('deploy_success', {
          deploymentId,
          url: result.event.url,
          assets: result.event.assets,
          workers: result.event.workers,
          durationMs: Date.now() - startedAt,
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
    execSync(preset.buildCommand, { cwd: root, stdio: 'inherit' });
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

  outro('Done!');
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
  const scanDirs = voidConfig.inference?.scanDirs ?? FRAMEWORK_SCAN_DIRS;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);
  const authEnabled =
    bindings.needsAuth || findVoidAuthConfig(root) !== null || voidConfig.auth !== undefined;

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

  const migrationsDir = join(root, 'db', 'migrations');

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
    try {
      const resources = await client.getResources(config.projectId);
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
    } catch {
      // Resources endpoint not available
    }
  }

  // 5. Generate wrapper if needed (crons or queues present)
  const rawJobs = scanJobsSync(root);
  const rawQueues = scanQueuesSync(root);
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

  // Step 2: Wrap if crons/queues are present (in-place, no re-bundling)
  if (needsWrapper(wrapperFeatures)) {
    log.step('Generating wrapper...');
    await generateWrapper(actualWorkerDir, actualWorkerMain, root, wrapperFeatures);
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
        env: { ...process.env, VOID_DEPLOY_PROJECT_ID: config.projectId },
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
  const dialect = getDatabaseDialect(deployConfig);
  const deployScanDirs =
    deployConfig.inference?.scanDirs ?? (isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined);
  const bindings = inferProjectBindings(root, undefined, deployScanDirs);
  if (isSandboxEnabled(deployConfig)) {
    bindings.needsSandbox = true;
  }
  const authEnabled =
    bindings.needsAuth || findVoidAuthConfig(root) !== null || deployConfig.auth !== undefined;
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

  const migrationsDir = join(root, 'db', 'migrations');

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
    try {
      const resources = await client.getResources(config.projectId);
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
    } catch {
      // Resources endpoint not available — Hyperdrive will be checked at deploy time
    }
  }
  const workerDirName = resolveWorkerDirName(distDir, fwPreset, frameworkBuildCmd);

  const schedules = scanJobsSync(root).flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const routeScan = await scanRoutes(root, { output: deployConfig.output });
  const webSockets = routeScan.websockets ?? scanWebSocketRoutesSync(root);
  const liveConfig = await resolveDeployLiveBindingConfig(root, client, config.projectId, {
    isFrameworkMode,
    needsLive: effectiveBindings.needsLive,
    webSockets,
    sandboxClassName: sandboxConfig?.className,
    cliLog,
  });
  const queues = scanQueuesSync(root).map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));
  const hasPages = existsSync(join(root, 'pages'));
  const hasRoutes = routeScan.routes.length > 0;
  const hasDocumentRoutes = routeScanHasDocumentRoutes(routeScan.routes);
  const hasMiddleware = routeScan.middleware.length > 0;
  const hasWebSockets = webSockets.length > 0;
  const isSsr = isFrameworkMode
    ? true
    : Boolean(validateSsrEntry(root)) || (hasPages && deployConfig.output !== 'static');

  // Resolve revalidate config from void.json + per-page .server.ts exports
  const vcRevalidate = readConfig(root).routing?.revalidate;
  let revalidate: number | Record<string, number> | undefined;
  if (vcRevalidate != null) {
    revalidate = vcRevalidate;
  }
  // Merge per-page revalidate exports (pages mode)
  const pageScan = existsSync(join(root, 'pages'))
    ? routeScan.pages.pages.length > 0
      ? routeScan.pages
      : await scanPages(root, { output: deployConfig.output })
    : null;
  if (pageScan) {
    const perPageRules: Record<string, number> = {};
    for (const page of pageScan.pages) {
      if (page.revalidate != null) {
        perPageRules[page.pattern] = page.revalidate;
      }
    }
    if (Object.keys(perPageRules).length > 0) {
      if (typeof revalidate === 'number') {
        // Global number → pathmap with "*" fallback, per-page entries first
        revalidate = Object.fromEntries([...Object.entries(perPageRules), ['*', revalidate]]);
      } else if (typeof revalidate === 'object') {
        // Per-page entries first (higher precedence in first-match)
        revalidate = Object.fromEntries([
          ...Object.entries(perPageRules),
          ...Object.entries(revalidate),
        ]);
      } else {
        revalidate = perPageRules;
      }
    }
  }

  // Fully-static optimization: if output: "static" and all pages are prerendered
  // with no backend features, deploy as a static site (no worker needed)
  if (deployConfig.output === 'static' && pageScan && !isSsr) {
    const allPrerenderable = pageScan.pages.every(
      (p) => p.prerender && ((p.params.length === 0 && !p.catchAll) || p.hasGetPrerenderPaths),
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
    hasDocumentRoutes,
    hasMiddleware,
    hasWebSockets,
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

  const manifest = buildVoidManifest({
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
  });
  const workerFiles = collectWorkerFiles(join(distDir, workerDirName));
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

    // Check if in a git repo
    execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore' });
    // Check if working tree is clean
    const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8' }).trim();
    if (status !== '') {
      return null;
    }
    // Get current commit hash
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim();
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
  if (!discoverSchema(root)) {
    return false;
  }

  const driftRoot = mkDeployDriftCheckRoot(root);
  const driftProjectRoot = join(driftRoot, 'project');

  createDeployDriftProject(root, driftProjectRoot);

  try {
    const migrationsDir = join(driftProjectRoot, 'db', 'migrations');
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
function loadDeployEnv(root: string): Record<string, string> {
  const files = ['.env', '.env.production'];
  const env: Record<string, string> = {};
  for (const file of files) {
    const filePath = join(root, file);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
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
