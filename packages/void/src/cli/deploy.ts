import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const deployDriftCheckDir = join('.void', 'deploy-drift-check');
import { intro, outro, log, note, spinner, confirm, isCancel } from '@clack/prompts';
import { findVoidAuthConfig } from '../auth/config';
import {
  readConfig,
  resolveBindingNames,
  type DatabaseDialect,
  type VoidConfig,
  getDatabaseDialect,
  isNodeTarget,
} from '../config';
import { convertHeadersConfig, convertRedirectsConfig } from '../config';
import { scanJobsSync } from '../crons/scan';
import { writeDrizzleConfig } from '../drizzle/config';
import { discoverSchema } from '../drizzle/discover';
import { collectMigrations } from '../migrations/collect';
import { validateMigrations } from '../migrations/validate';
import { scanPages } from '../pages/scan';
import {
  inferProjectBindings,
  FRAMEWORK_SCAN_DIRS,
  detectFramework,
  type DetectedFramework,
} from '../plugin-inference';
import { collectPrerenderPaths, collectPrerenderPathsNode } from '../prerender';
import { scanQueuesSync } from '../queues/scan';
import { scanWebSocketRoutesSync } from '../router/websocket';
import { validateSsrEntry } from '../ssr/entry';
import { getToken, getTokenSource } from './auth';
import { isExpiredTokenError, PlatformClient } from './client';
import { parseHeadersFile, parseRedirectsFile } from './headers';
import { promptForLoginToken } from './login';
import { cliTitle } from './output';
import {
  packageBuild,
  packageStaticBuild,
  packageFrameworkBuild,
  collectAndHashAssets,
} from './package';
import {
  detectPreset,
  FRAMEWORK_PRESETS,
  formatProjectCommand,
  resolveProjectCommand,
  type StaticPreset,
  type FrameworkPreset,
} from './preset';
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from './project';
import { promptProjectSelection, promptProjectSlug } from './prompt';
import { getRequestedProjectSlug, resolveProjectBySlug, inferDefaultSlug } from './resolve-project';
import type { AssetConfig, DeployEvent, HeaderRule, RedirectRule } from './types';
import { readWranglerCompat } from './wrangler';
import { needsWrapper, generateWrapper, bundleEntry, cleanupWrapper } from './wrapper';
import type { WrapperFeatures } from './wrapper';

export interface RunDeployOptions {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
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

  let reauthenticated = false;
  while (true) {
    try {
      // 1. Auth
      const token = getToken();
      if (!token) {
        log.error('No auth token found. Run `void auth login` first.');
        process.exit(1);
      }

      const client = new PlatformClient(token);

      // 2. Resolve target project (CLI flag > env var > linked project file)
      const requestedProjectSlug = getRequestedProjectSlug(options);
      let config: ProjectConfig | null = null;

      if (requestedProjectSlug) {
        const projects = await client.listProjects();
        config = resolveProjectBySlug(projects, requestedProjectSlug);

        if (!config) {
          if (!process.stdin.isTTY) {
            // CI: auto-create when --project is explicitly specified
            config = await createNewProject(root, client, requestedProjectSlug);
          } else {
            const shouldCreate = await confirm({
              message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
            });
            if (isCancel(shouldCreate) || !shouldCreate) {
              log.info('Deploy cancelled.');
              process.exit(0);
            }

            config = await createNewProject(root, client, requestedProjectSlug);
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
        const projects = await client.listProjects();

        if (projects.length > 0) {
          // User has existing projects — let them choose
          const result = await promptProjectSelection(projects, 'Select a project to deploy to:');

          if (result.action === 'select') {
            config = { projectId: result.project.id, slug: result.project.slug };
            writeProjectConfig(root, config);
            log.step(`Linked to ${config.slug}`);
          } else {
            const slug = await promptProjectSlug(inferDefaultSlug(root));
            config = await createNewProject(root, client, slug);
          }
        } else {
          const slug = await promptProjectSlug(inferDefaultSlug(root));
          config = await createNewProject(root, client, slug);
        }
      }

      // 3. Resolve deploy app type: void.json > CLI flags > auto-detection
      const voidConfig = readConfig(root);

      // Check for known framework first
      const detected = detectFramework(root);
      if (detected) {
        const gitCommit = options?.skipBuild ? null : getGitCommit(root);
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
            gitCommit,
          );
        } else {
          // Class A: preset is optional (e.g. vinext probes at runtime)
          await runFullDeploy(
            root,
            config,
            client,
            fwPreset,
            options?.skipBuild,
            gitCommit,
            detected,
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
      const gitCommit = options?.skipBuild ? null : getGitCommit(root);

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
          gitCommit,
          undefined,
          convertHeadersConfig(voidConfig.routing?.headers) ?? [],
          convertRedirectsConfig(voidConfig.routing?.redirects) ?? [],
        );
      } else {
        await runFullDeploy(root, config, client, undefined, options?.skipBuild, gitCommit);
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
        await promptForLoginToken();
        log.success('Re-authenticated. Retrying deploy...');
        reauthenticated = true;
        continue;
      }
      throw error;
    }
  }
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

async function streamDeploy(
  client: PlatformClient,
  projectId: string,
  formData: FormData,
  s: ReturnType<typeof spinner>,
): Promise<Extract<DeployEvent, { event: 'done' }>> {
  for await (const event of client.deploy(projectId, formData)) {
    switch (event.event) {
      case 'start':
        s.message('Deploying...');
        break;
      case 'asset_upload':
        if (event.new > 0) {
          s.message(`Uploading assets (${event.new} new, ${event.cached} cached)`);
        } else {
          s.message(`Uploading assets (${event.total} cached)`);
        }
        break;
      case 'provisioning':
        s.message(`Provisioning ${event.bindings.join(', ')}`);
        break;
      case 'migration_start':
        s.message(`Running ${event.pending} migration${event.pending > 1 ? 's' : ''}...`);
        break;
      case 'migration':
        s.message(`Applied migration: ${event.name} (${event.durationMs}ms)`);
        break;
      case 'worker_upload':
        s.message('Uploading worker...');
        break;
      case 'prerender':
        s.message(`Prerendering ${event.pages} pages...`);
        break;
      case 'done':
        s.stop('Deployed!');
        return event;
      case 'error':
        s.stop('Deploy failed');
        throw new Error(event.message);
    }
  }
  // Stream ended without done/error — connection dropped
  s.stop('Deploy failed');
  throw new Error('Connection lost during deploy');
}

async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  skipBuild?: boolean,
  commit?: string | null,
  hashedAssetsPrefix?: string,
  headerRules?: HeaderRule[],
  redirectRules?: RedirectRule[],
): Promise<void> {
  const typeLabel = preset.appType === 'spa' ? 'Static SPA' : 'Static Site';
  log.info(`${typeLabel} deploy`);

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step('Building...');
    execSync(preset.buildCommand, { cwd: root, stdio: 'inherit' });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`Output directory not found: ${preset.outputDir}`);
    process.exit(1);
  }

  const s = spinner();

  // Preflight: hash assets and check which ones changed
  s.start('Checking for changes...');
  const { assetManifest } = collectAndHashAssets(preset.outputDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);
  s.stop('Checked for changes');

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageStaticBuild(
    preset.outputDir,
    preset.appType,
    neededSet,
    hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
  );
  if (neededSet) {
    formData.append('assetManifest', JSON.stringify(assetManifest));
  }
  formData.append('source', getTokenSource());
  if (commit) {
    formData.append('commit', commit);
  }

  const result = await streamDeploy(client, config.projectId, formData, s);

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${typeLabel} — ${assetSummary}`];
  note(summary.join('\n'), result.url);

  outro('Done!');
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
  commit?: string | null,
): Promise<void> {
  log.info(`${detected.name} framework deploy`);

  const dialect = getDatabaseDialect(voidConfig);

  // 1. Build
  const buildCmd = voidConfig.inference?.build ?? formatProjectCommand(root, fwPreset.buildCommand);
  if (!skipBuild) {
    log.step(`Building (${buildCmd})...`);
    execSync(voidConfig.inference?.build ?? resolveProjectCommand(root, fwPreset.buildCommand), {
      cwd: root,
      stdio: 'inherit',
    });
  }

  // 2. Verify output paths
  const workerDir = join(root, fwPreset.workerDir);
  const assetsDir = join(root, fwPreset.assetsDir);

  // Collect header rules: parse framework-generated _headers file + void.json config
  const fwHeaderRules = existsSync(assetsDir) ? parseHeadersFile(assetsDir) : undefined;
  const cfgHeaderRules = convertHeadersConfig(voidConfig.routing?.headers);
  const headerRules: HeaderRule[] = [...(fwHeaderRules ?? []), ...(cfgHeaderRules ?? [])];

  // Collect redirect rules: parse framework-generated _redirects file + void.json config
  const fwRedirectRules = existsSync(assetsDir) ? parseRedirectsFile(assetsDir) : undefined;
  const cfgRedirectRules = convertRedirectsConfig(voidConfig.routing?.redirects);
  const redirectRules: RedirectRule[] = [...(fwRedirectRules ?? []), ...(cfgRedirectRules ?? [])];

  if (!existsSync(workerDir)) {
    log.error(`Worker output not found at "${fwPreset.workerDir}". Run "${buildCmd}" first.`);
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
      "Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }

  assertDeploySchemaDriftFree(root, dialect);

  // 4. Collect migrations (before Hyperdrive check so migrations can gate provisioning)
  const migrationsDir = join(root, 'db', 'migrations');
  const rawMigrations = collectMigrations(migrationsDir);
  let validatedMigrations;
  if (rawMigrations.length > 0) {
    try {
      validatedMigrations = validateMigrations(rawMigrations);
      log.info(`Found ${validatedMigrations.length} migration(s)`);
    } catch (err: any) {
      log.error(err.message);
      process.exit(1);
    }
  }

  // Pre-deploy: ensure Hyperdrive is provisioned for PostgreSQL projects
  if (dialect === 'postgresql' && (bindings.needsD1 || rawMigrations.length > 0)) {
    try {
      const resources = await client.getResources(config.projectId);
      const hasHyperdrive = resources.some((r: any) => r.type === 'hyperdrive');
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

  // 8. Read wrangler compat settings (void.json > wrangler.jsonc > build output > default)
  // Use the original workerDir (not actualWorkerDir) because bundleEntry() may
  // reassign actualWorkerDir to a temporary output — the plugin-generated
  // wrangler.json with correct compat settings lives in the original build output.
  const wranglerCompat = readWranglerCompat(root, voidConfig, workerDir);

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

  // 11. Package & deploy
  const s = spinner();

  // Preflight: hash assets and check which ones changed
  s.start('Checking for changes...');
  const { assetManifest } = collectAndHashAssets(assetsDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageFrameworkBuild({
    frameworkName: detected.name,
    workerDir: actualWorkerDir,
    workerMain: actualWorkerMain,
    assetsDir,
    bindings,
    migrations: validatedMigrations,
    schedules,
    queues,
    revalidate,
    prerender,
    assetConfig: { not_found_handling: 'none' },
    vars: envVars,
    packageOptions: {
      bindingNames: resolveBindingNames(voidConfig.inference?.bindings),
      workerMain: actualWorkerMain,
      compatibilityDate: wranglerCompat.compatibilityDate,
      compatibilityFlags: wranglerCompat.compatibilityFlags,
    },
    neededAssets: neededSet,
    hashedAssetsPrefix: fwPreset.hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
    dialect,
  });
  if (neededSet) {
    formData.append('assetManifest', JSON.stringify(assetManifest));
  }
  formData.append('source', getTokenSource());
  if (commit) {
    formData.append('commit', commit);
  }

  const result = await streamDeploy(client, config.projectId, formData, s);

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${result.workers} worker module(s), ${assetSummary}`];
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
  commit?: string | null,
  detected?: DetectedFramework,
): Promise<void> {
  // 3. Build (child process to avoid Vite API side effects on bundle output)
  if (!skipBuild) {
    const buildCmd = formatProjectCommand(root, 'vite build');
    log.step(`Building (${buildCmd})...`);
    try {
      execSync(resolveProjectCommand(root, 'vite build'), { cwd: root, stdio: 'inherit' });
    } catch (err: any) {
      process.exit(err.status ?? 1);
    }
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
  const authEnabled =
    bindings.needsAuth || findVoidAuthConfig(root) !== null || deployConfig.auth !== undefined;
  const effectiveBindings =
    authEnabled && !bindings.needsD1 ? { ...bindings, needsD1: true } : bindings;

  if (isFrameworkMode && authEnabled) {
    log.error(
      "Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }

  // Collect header rules: parse user/framework _headers file + void.json config
  const clientDir = join(distDir, 'client');
  const userHeaderRules = existsSync(clientDir) ? parseHeadersFile(clientDir) : undefined;
  const cfgHeaderRules = convertHeadersConfig(deployConfig.routing?.headers);
  const headerRules: HeaderRule[] = [...(userHeaderRules ?? []), ...(cfgHeaderRules ?? [])];

  // Collect redirect rules: parse user/framework _redirects file + void.json config
  const userRedirectRules = existsSync(clientDir) ? parseRedirectsFile(clientDir) : undefined;
  const cfgRedirectRules = convertRedirectsConfig(deployConfig.routing?.redirects);
  const redirectRules: RedirectRule[] = [...(userRedirectRules ?? []), ...(cfgRedirectRules ?? [])];

  assertDeploySchemaDriftFree(root, dialect);

  // 7. Collect and validate migrations (before Hyperdrive check so migrations can gate provisioning)
  const migrationsDir = join(root, 'db', 'migrations');
  const rawMigrations = collectMigrations(migrationsDir);
  let validatedMigrations;
  if (rawMigrations.length > 0) {
    try {
      validatedMigrations = validateMigrations(rawMigrations);
      log.info(`Found ${validatedMigrations.length} migration(s)`);
    } catch (err: any) {
      log.error(err.message);
      process.exit(1);
    }
  }

  // Pre-deploy: ensure Hyperdrive is provisioned for PostgreSQL projects.
  // Migrations on disk also gate this — even if inference says needsD1: false,
  // packageBuild will add the hyperdrive binding when migrations are present.
  if (dialect === 'postgresql' && (effectiveBindings.needsD1 || rawMigrations.length > 0)) {
    try {
      const resources = await client.getResources(config.projectId);
      const hasHyperdrive = resources.some((r: any) => r.type === 'hyperdrive');
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
  const webSockets = scanWebSocketRoutesSync(root);
  const queues = scanQueuesSync(root).map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));
  const hasPages = existsSync(join(root, 'pages'));
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
    ? await scanPages(root, { output: deployConfig.output })
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
      existsSync(join(root, 'routes')) || existsSync(join(root, 'middleware'));
    if (allPrerenderable && !hasNonPageBackend && schedules.length === 0 && queues.length === 0) {
      log.info('All pages prerendered — deploying as static site');
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
        commit,
        assetsPrefix,
        headerRules,
        redirectRules,
      );
    }
  }

  // Resolve prerender paths (skip when output: "static" — pages are already built as static assets)
  const uniquePrerenderPaths =
    deployConfig.output === 'static'
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
          });

  // 8. Read wrangler compat settings (void.json > wrangler.jsonc > build output > default)
  const wranglerCompat = readWranglerCompat(root, deployConfig, join(distDir, workerDirName));

  // 9. Load .env vars for production (excludes .local files)
  const envVars = loadDeployEnv(root);

  // 10. Package & Upload
  const s = spinner();

  // Derive asset config: SSR and pages-mode workers handle their own 404s, non-SSR uses SPA fallback
  const assetConfig: AssetConfig =
    isSsr || hasPages
      ? { not_found_handling: 'none' }
      : { not_found_handling: 'single-page-application' };

  // Preflight: hash assets and check which ones changed
  s.start('Checking for changes...');
  const { assetManifest } = collectAndHashAssets(clientDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.start('Packaging...');
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageBuild(
    distDir,
    workerDirName,
    effectiveBindings,
    validatedMigrations,
    schedules,
    isSsr,
    isFrameworkMode ? detected!.name : undefined,
    revalidate,
    envVars,
    queues,
    uniquePrerenderPaths,
    assetConfig,
    {
      compatibilityDate: wranglerCompat.compatibilityDate,
      compatibilityFlags: wranglerCompat.compatibilityFlags,
    },
    neededSet,
    assetsPrefix,
    headerRules,
    redirectRules,
    dialect,
    webSockets,
  );
  if (neededSet) {
    formData.append('assetManifest', JSON.stringify(assetManifest));
  }
  formData.append('source', getTokenSource());
  if (commit) {
    formData.append('commit', commit);
  }

  const result = await streamDeploy(client, config.projectId, formData, s);

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${result.workers} worker module(s), ${assetSummary}`];
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

async function createNewProject(
  root: string,
  client: PlatformClient,
  slug?: string,
): Promise<ProjectConfig> {
  const projectSlug = slug ?? inferDefaultSlug(root);

  log.step(`Creating project "${projectSlug}"...`);
  const project = await client.createProject(projectSlug);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  log.success(`Project created: ${config.slug}`);
  return config;
}

function getGitCommit(root: string): string | null {
  try {
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
  } catch (error: any) {
    log.error(error.message);
    process.exit(1);
  }

  log.error(getDeploySchemaDriftMessage());
  process.exit(1);
}

export function hasDeploySchemaDrift(root: string, dialect: DatabaseDialect): boolean {
  if (!discoverSchema(root)) {
    return false;
  }

  const driftRoot = mkDeployDriftCheckRoot();
  const driftProjectRoot = join(driftRoot, 'project');

  rmSync(driftRoot, { recursive: true, force: true });
  mkdirSync(driftRoot, { recursive: true });
  createDeployDriftProject(root, driftProjectRoot);

  try {
    const migrationsDir = join(driftProjectRoot, 'db', 'migrations');
    const before = snapshotDir(migrationsDir);
    const driftConfigPath = writeDrizzleConfig(
      driftProjectRoot,
      dialect === 'postgresql' ? 'postgresql://dummy' : ':memory:',
      dialect,
    );

    execFileSync(process.execPath, [drizzleKitBin, 'generate', '--config', driftConfigPath], {
      cwd: driftProjectRoot,
      stdio: 'pipe',
    });

    return !migrationSnapshotsEqual(before, snapshotDir(migrationsDir));
  } catch (error) {
    throw new Error(formatDeploySchemaDriftCheckError(error));
  } finally {
    rmSync(driftRoot, { recursive: true, force: true });
  }
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

    if (entry.name === 'db') {
      cpSync(source, target, { recursive: true });
      continue;
    }

    symlinkSync(source, target, entry.isDirectory() ? symlinkDirType() : 'file');
  }

  const nodeModules = findNearestNodeModules(root);
  if (nodeModules) {
    symlinkSync(nodeModules, join(driftProjectRoot, 'node_modules'), symlinkDirType());
  }
}

function findNearestNodeModules(root: string): string | null {
  let current = root;
  while (true) {
    const candidate = join(current, 'node_modules');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function mkDeployDriftCheckRoot(): string {
  return join(
    tmpdir(),
    `${deployDriftCheckDir.replaceAll('/', '-').replaceAll('\\', '-')}-${Date.now()}`,
  );
}

function symlinkDirType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
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
  return env;
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
        `Build output directory "${topDir}" not found. Run "${buildCommand ?? fwPreset.buildCommand}" first.`,
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
        `Worker output not found at "${fwPreset.workerDir}". Run "${buildCommand ?? fwPreset.buildCommand}" first.`,
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
  throw new Error('Worker output not found: expected dist/ssr/ or dist/rsc/');
}
