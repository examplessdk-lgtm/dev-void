import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'pathslash';
import { analyzeApplicationSync } from '../application-analysis.ts';
import { type VoidConfig } from '../config.ts';
import { scanDurableObjectModules } from '../durable/scan.ts';
import { collectRevalidate } from '../isr-config.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { type DetectedFramework } from '../plugin-inference.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { PlatformClient } from './client.ts';
import { assertDeploySchemaDriftFree } from './deploy-drift.ts';
import {
  log,
  getErrorMessage,
  generateDeployWrapperIfNeeded,
  resolveDeployWranglerCompat,
  assertEnvSchemaValid,
} from './deploy-helpers.ts';
import {
  warnRedundantForceOn3xx,
  warnIgnoredNotFoundForFramework,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import { type ResourceSummary } from './deploy-types.ts';
import { type GitDeployMetadata } from './git-metadata.ts';
import { lintDestinationSplats, lintDuplicateSources, mergeRoutingRules } from './headers.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import { collectAndHashAssets, buildFrameworkManifest, collectWorkerFiles } from './package.ts';
import { formatProjectCommand, resolveProjectCommand, type FrameworkPreset } from './preset.ts';
import { type ProjectConfig } from './project.ts';
import type { WrapperFeatures } from './wrapper.ts';
import { needsWrapper, bundleEntry, cleanupWrapper } from './wrapper.ts';

/**
 * Class B/C framework deploy: build with framework CLI, package with preset output paths.
 */
export async function runFrameworkDeploy(
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
      log.info(`Found ${formatCount(validatedMigrations.length, 'migration')}`);
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
        const { text: promptText, isCancel: isCancelPrompt } =
          await import('@voidzero-dev/vite-plus-prompts');
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
    log.info(`Skipping ${formatCount(skipped, 'unchanged asset')}`);
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

  note(
    formatDeploySummary({
      workers: result.workers,
      assets: result.assets,
      unchangedAssets: skipped,
      migrations: result.migrations,
      cronJobs: schedules.length,
      queues: queues.length,
      prerenderedPages: prerender?.length,
      revalidate,
      framework: detected.name,
    }),
    result.url,
  );

  // Clean up generated wrapper files
  cleanupWrapper(root);

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}

export function assertManagedDurableStateSupported(root: string): void {
  if (scanDurableObjectModules(root).length > 0) {
    throw new Error(
      'deploy: typed Durable State modules in durable-objects/ are not yet supported by the Void managed platform. Deploy to your own Cloudflare account with `void deploy --platform cloudflare`.',
    );
  }
}
