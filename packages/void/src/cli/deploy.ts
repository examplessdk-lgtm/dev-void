import { intro, outro, log, note, spinner, confirm, isCancel } from "@clack/prompts";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadEnv } from "vite";

import type { HeaderRule } from "./types";

import {
  readConfig,
  convertHeadersConfig,
  resolveBindingNames,
  type AuthProvider,
  type VoidConfig,
} from "../config";
import { scanJobsSync } from "../crons/scan";
import { collectMigrations } from "../migrations/collect";
import { validateMigrations } from "../migrations/validate";
import { scanPages } from "../pages/scan";
import {
  inferProjectBindings,
  FRAMEWORK_SCAN_DIRS,
  detectFramework,
  type DetectedFramework,
} from "../plugin-inference";
import { scanQueuesSync } from "../queues/scan";
import { validateSsrEntry, detectSsrPrerender, getSsrServerEntryPath } from "../ssr/entry";
import { getToken, getTokenSource } from "./auth";
import { PlatformClient } from "./client";
import { parseHeadersFile } from "./headers";
import { cliTitle } from "./output";
import {
  computeAssetHashes,
  packageBuild,
  packageStaticBuild,
  packageFrameworkBuild,
} from "./package";
import { detectPreset, FRAMEWORK_PRESETS, type StaticPreset, type FrameworkPreset } from "./preset";
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from "./project";
import { promptProjectSelection, promptProjectSlug } from "./prompt";
import { getRequestedProjectSlug, resolveProjectBySlug, inferDefaultSlug } from "./resolve-project";
import { readWranglerCompat } from "./wrangler";
import {
  needsWrapper,
  generateAndBundleWrapper,
  cleanupWrapper,
  type WrapperFeatures,
} from "./wrapper";

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
  intro(cliTitle("deploy"));

  // 1. Auth
  const token = getToken();
  if (!token) {
    log.error("No auth token found. Run `void login` first.");
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
        log.error(`No project found with slug "${requestedProjectSlug}".`);
        process.exit(1);
      }

      const shouldCreate = await confirm({
        message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
      });
      if (isCancel(shouldCreate) || !shouldCreate) {
        log.info("Deploy cancelled.");
        process.exit(0);
      }

      config = await createNewProject(root, client, requestedProjectSlug);
    }
  } else {
    config = readProjectConfig(root);
  }

  if (!config) {
    const projects = await client.listProjects();

    if (projects.length > 0) {
      // User has existing projects — let them choose
      const result = await promptProjectSelection(projects, "Select a project to deploy to:");

      if (result.action === "select") {
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

  // 3. Resolve deploy mode: void.json > CLI flags > auto-detection
  const vcConfig = readConfig(root);
  const headers = convertHeadersConfig(vcConfig.headers);

  // Check for Class B/C framework first
  const detected = detectFramework(root);
  if (detected && (detected.class === "b" || detected.class === "c")) {
    const fwPreset = FRAMEWORK_PRESETS[detected.name];
    if (!fwPreset) {
      log.error(`No deploy preset found for framework "${detected.name}".`);
      process.exit(1);
    }
    const gitCommit = options?.skipBuild ? null : getGitCommit(root);
    await runFrameworkDeploy(
      root,
      config,
      client,
      detected,
      fwPreset,
      vcConfig,
      headers,
      options?.skipBuild,
      gitCommit,
    );
    return;
  }

  let preset: StaticPreset | null = null;

  if (vcConfig.mode && vcConfig.mode !== "fullstack" && vcConfig.mode !== "framework") {
    // void.json has an explicit static mode
    preset = {
      buildCommand: null,
      outputDir: vcConfig.outputDir ? resolve(root, vcConfig.outputDir) : join(root, "dist"),
      mode: vcConfig.mode,
    };
    // Re-detect build command (config stores mode, not command)
    const detectedPreset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
    if (detectedPreset) {
      preset.buildCommand = detectedPreset.buildCommand;
      if (!vcConfig.outputDir) {
        preset.outputDir = detectedPreset.outputDir;
      }
    }
  } else if (!vcConfig.mode) {
    // No configured mode — detect from CLI flags + project structure
    preset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
  }
  // vcConfig.mode === "fullstack" or "framework" → preset stays null → full deploy

  // Detect git commit before build (only when not skipping build)
  const gitCommit = options?.skipBuild ? null : getGitCommit(root);

  if (preset) {
    await runStaticDeploy(root, config, client, preset, headers, options?.skipBuild, gitCommit);
  } else {
    await runFullDeploy(root, config, client, headers, options?.skipBuild, gitCommit);
  }
}

async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  headers?: HeaderRule[],
  skipBuild?: boolean,
  commit?: string | null,
): Promise<void> {
  const modeLabel = preset.mode === "spa" ? "Static SPA" : "Static SSG";
  log.info(`${modeLabel} deploy`);

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step("Building...");
    execSync(preset.buildCommand, { cwd: root, stdio: "inherit" });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`Output directory not found: ${preset.outputDir}`);
    process.exit(1);
  }

  // Package & Upload
  const s = spinner();

  s.start("Checking assets...");
  const hashes = computeAssetHashes(preset.outputDir);
  const totalAssets = Object.keys(hashes).length;
  const needed = await client.checkAssets(config.projectId, hashes);
  s.message(
    `Uploading ${needed.length}/${totalAssets} assets (${totalAssets - needed.length} cached)`,
  );
  const formData = packageStaticBuild(
    preset.outputDir,
    preset.mode,
    new Set(needed),
    hashes,
    headers,
  );
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const summary = [`${modeLabel} — ${result.assets} static asset(s)`];
  note(summary.join("\n"), result.url);

  outro("Done!");
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
  vcConfig: VoidConfig,
  headers?: HeaderRule[],
  skipBuild?: boolean,
  commit?: string | null,
): Promise<void> {
  log.info(`${detected.name} (Class ${detected.class.toUpperCase()}) deploy`);

  // 1. Build
  if (!skipBuild) {
    const buildCmd = vcConfig.build ?? fwPreset.buildCommand;
    log.step(`Building (${buildCmd})...`);
    execSync(buildCmd, { cwd: root, stdio: "inherit" });
  }

  // 2. Verify output paths
  const workerDir = join(root, fwPreset.workerDir);
  const assetsDir = join(root, fwPreset.assetsDir);

  if (!existsSync(workerDir)) {
    log.error(`Worker output not found: ${fwPreset.workerDir}`);
    process.exit(1);
  }

  // 3. Infer or read bindings
  const inferenceOptions = vcConfig.bindings ? { bindings: vcConfig.bindings } : undefined;
  const scanDirs = vcConfig.scanDirs ?? FRAMEWORK_SCAN_DIRS;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);

  // 4. Collect migrations
  const migrationsDir = join(root, "migrations");
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

  // 5. Resolve auth config (explicit config takes precedence, otherwise infer from source)
  const authProviders: AuthProvider[] | null = vcConfig.auth
    ? vcConfig.auth === true
      ? (["email"] as AuthProvider[])
      : vcConfig.auth
    : bindings.needsAuth
      ? ["email"]
      : null;

  // 7. Generate wrapper if needed (auth, crons, or queues present)
  const rawJobs = scanJobsSync(root);
  const rawQueues = scanQueuesSync(root);
  const originalEntry = join(workerDir, fwPreset.workerMain);

  const wrapperFeatures: WrapperFeatures = {
    originalEntry,
    auth: authProviders,
    crons: rawJobs,
    queues: rawQueues,
  };

  let actualWorkerDir = workerDir;
  let actualWorkerMain = fwPreset.workerMain;

  if (needsWrapper(wrapperFeatures)) {
    log.step("Generating wrapper...");
    const wrapperResult = await generateAndBundleWrapper(root, wrapperFeatures);
    actualWorkerDir = wrapperResult.outputDir;
    actualWorkerMain = wrapperResult.entryFilename;
    log.info("Wrapper bundled");
  }

  // 8. Read wrangler compat settings
  const wranglerCompat = readWranglerCompat(root);

  // 9. Resolve revalidate + prerender from void.json
  const revalidate = vcConfig.cache?.revalidate;
  const prerender = vcConfig.cache?.prerender;

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

  // 10. Load .env vars for production
  const envVars = loadEnv("production", root, "");

  // 11. Check assets & Package
  const s = spinner();

  s.start("Checking assets...");
  let neededPaths: Set<string> | undefined;
  let assetHashes: Record<string, string> | undefined;
  try {
    assetHashes = computeAssetHashes(assetsDir);
    // Exclude worker files from asset hashes when dirs overlap
    const workerDirNorm = workerDir.replace(/\\/g, "/");
    const assetsDirNorm = assetsDir.replace(/\\/g, "/");
    if (workerDirNorm.startsWith(assetsDirNorm + "/") || workerDirNorm === assetsDirNorm) {
      const workerFiles = new Set(
        Object.keys(assetHashes).filter((p) => {
          const full = join(assetsDir, p).replace(/\\/g, "/");
          return full.startsWith(workerDirNorm);
        }),
      );
      for (const wf of workerFiles) {
        delete assetHashes[wf];
      }
    }
    const totalAssets = Object.keys(assetHashes).length;
    const needed = await client.checkAssets(config.projectId, assetHashes);
    neededPaths = new Set(needed);
    s.message(
      `Uploading ${needed.length}/${totalAssets} assets (${totalAssets - needed.length} cached)`,
    );
  } catch {
    // No assets directory
  }

  // Parse framework-generated _headers and merge with void.json rules
  const frameworkHeaders = parseHeadersFile(assetsDir);
  const mergedHeaders: HeaderRule[] | undefined =
    frameworkHeaders || headers ? [...(frameworkHeaders ?? []), ...(headers ?? [])] : undefined;

  s.message("Packaging...");
  const formData = packageFrameworkBuild({
    workerDir: actualWorkerDir,
    workerMain: actualWorkerMain,
    assetsDir,
    bindings,
    migrations: validatedMigrations,
    schedules,
    queues,
    revalidate,
    prerender,
    headers: mergedHeaders,
    hashedAssetsPrefix: fwPreset.hashedAssetsPrefix,
    vars: envVars,
    neededPaths,
    assetHashes,
    packageOptions: {
      bindingNames: resolveBindingNames(vcConfig.bindings),
      workerMain: actualWorkerMain,
      compatibilityDate: wranglerCompat.compatibilityDate,
      compatibilityFlags: wranglerCompat.compatibilityFlags,
    },
  });
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const summary = [`${result.workers} worker module(s), ${result.assets} static asset(s)`];
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
    if (typeof revalidate === "number") {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
  }
  summary.push(`Framework: ${detected.name}`);
  note(summary.join("\n"), result.url);

  // Clean up generated wrapper files
  cleanupWrapper(root);

  outro("Done!");
}

async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  headers?: HeaderRule[],
  skipBuild?: boolean,
  commit?: string | null,
): Promise<void> {
  // 3. Build (child process to avoid Vite API side effects on bundle output)
  if (!skipBuild) {
    log.step("Building...");
    const viteBin = fileURLToPath(
      new URL("bin/vite.js", import.meta.resolve("vite/package.json")).href,
    );
    try {
      execFileSync(process.execPath, [viteBin, "build"], { cwd: root, stdio: "inherit" });
    } catch (err: any) {
      process.exit(err.status ?? 1);
    }
  }

  // 4. Resolve build output paths from build artifacts (avoids re-resolving
  // Vite config in the main process — plugins only run once inside the build)
  const distDir = join(root, "dist");

  // Detect non-default assetsDir from Vite client manifest
  let assetsDir: string | undefined;
  const clientManifestPath = join(distDir, "client", ".vite", "manifest.json");
  if (existsSync(clientManifestPath)) {
    const manifest: Record<string, { file?: string }> = JSON.parse(
      readFileSync(clientManifestPath, "utf-8"),
    );
    for (const entry of Object.values(manifest)) {
      if (entry.file?.includes("/")) {
        const dir = entry.file.slice(0, entry.file.indexOf("/"));
        if (dir !== "assets") assetsDir = dir;
        break;
      }
    }
  }

  // 5. Detect framework mode (Class A only for existing flow)
  const detected = detectFramework(root);
  const isFrameworkMode = detected?.class === "a";

  // 6. Infer bindings (expanded scan dirs in framework mode, or custom from config)
  const deployConfig = readConfig(root);
  const deployScanDirs =
    deployConfig.scanDirs ?? (isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined);
  const bindings = inferProjectBindings(root, undefined, deployScanDirs);

  // 7. Collect and validate migrations
  const migrationsDir = join(root, "migrations");
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
  const workerDirName = detectWorkerDir(root, distDir);

  // Inject client manifest into worker entry so SSR/Pages asset tags work
  // in production. The worker has no ASSETS binding in Workers for Platforms,
  // so the generated code checks globalThis.__VITE_MANIFEST__ at runtime.
  const workerEntryPath = join(distDir, workerDirName, "index.js");
  if (existsSync(clientManifestPath) && existsSync(workerEntryPath)) {
    const manifestJson = readFileSync(clientManifestPath, "utf-8");
    const workerCode = readFileSync(workerEntryPath, "utf-8");
    writeFileSync(workerEntryPath, `globalThis.__VITE_MANIFEST__=${manifestJson};\n${workerCode}`);
  }

  const schedules = scanJobsSync(root).flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const queues = scanQueuesSync(root).map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));
  const isSsr = isFrameworkMode ? true : Boolean(validateSsrEntry(root));

  // Resolve revalidate config from void.json + per-page .server.ts exports
  const vcRevalidate = readConfig(root).cache?.revalidate;
  let revalidate: number | Record<string, number> | undefined;
  if (vcRevalidate != null) {
    revalidate = vcRevalidate;
  }
  // Merge per-page revalidate exports (pages mode)
  const pageScan = existsSync(join(root, "pages")) ? await scanPages(root) : null;
  if (pageScan) {
    const perPageRules: Record<string, number> = {};
    for (const page of pageScan.pages) {
      if (page.revalidate != null) {
        perPageRules[page.pattern] = page.revalidate;
      }
    }
    if (Object.keys(perPageRules).length > 0) {
      if (typeof revalidate === "number") {
        // Global number → pathmap with "*" fallback, per-page entries first
        revalidate = Object.fromEntries([...Object.entries(perPageRules), ["*", revalidate]]);
      } else if (typeof revalidate === "object") {
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

  // Resolve prerender paths
  const prerenderPaths: string[] = [];
  if (pageScan) {
    // Static pages: no params, prerender = true
    for (const page of pageScan.pages) {
      if (page.prerender && page.params.length === 0 && !page.catchAll) {
        prerenderPaths.push(page.pattern);
      }
    }
    // Dynamic pages: prerender = true + getPrerenderPaths
    const dynamicPrerenderPages = pageScan.pages.filter(
      (p) => p.prerender && p.hasGetPrerenderPaths && (p.params.length > 0 || p.catchAll),
    );
    if (dynamicPrerenderPages.length > 0) {
      const viteServer = await createServer({
        root,
        server: { middlewareMode: true },
        logLevel: "silent",
      });
      try {
        for (const page of dynamicPrerenderPages) {
          try {
            const serverFile = page.serverPath
              ? join(root, "pages", page.serverPath)
              : join(root, "pages", page.componentPath);
            const mod = await viteServer.ssrLoadModule(serverFile);
            if (typeof mod.getPrerenderPaths === "function") {
              const paramSets = await mod.getPrerenderPaths();
              if (Array.isArray(paramSets)) {
                for (const params of paramSets) {
                  let path = page.pattern;
                  for (const [key, value] of Object.entries(params as Record<string, string>)) {
                    path = path.replace(`:${key}`, value);
                  }
                  prerenderPaths.push(path);
                }
              }
            }
          } catch (err) {
            log.warn(
              `Failed to resolve prerender paths for ${page.pattern}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } finally {
        await viteServer.close();
      }
    }
  }

  // Custom SSR: getPrerenderPaths() in src/main.ssr.ts
  const ssrPrerender = detectSsrPrerender(root);
  if (ssrPrerender?.hasGetPrerenderPaths) {
    const viteServer = await createServer({
      root,
      server: { middlewareMode: true },
      logLevel: "silent",
    });
    try {
      const entryPath = getSsrServerEntryPath(root)!;
      const mod = await viteServer.ssrLoadModule(entryPath);
      if (typeof mod.getPrerenderPaths === "function") {
        const paths = await mod.getPrerenderPaths();
        if (Array.isArray(paths)) {
          for (const p of paths) {
            if (typeof p === "string") prerenderPaths.push(p);
          }
        }
      }
    } catch (err) {
      log.warn(
        `Failed to resolve SSR prerender paths: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await viteServer.close();
    }
  }

  // Add explicit prerender paths from void.json cache.prerender
  const configPrerender = readConfig(root).cache?.prerender;
  if (configPrerender) {
    prerenderPaths.push(...configPrerender);
  }

  // Dedupe prerender paths
  const uniquePrerenderPaths = [...new Set(prerenderPaths)];

  // 8. Load .env vars for production
  const envVars = loadEnv("production", root, "");

  // 9. Check assets & Package & Upload
  const s = spinner();

  s.start("Checking assets...");
  const clientDir = join(distDir, "client");
  let neededPaths: Set<string> | undefined;
  let assetHashes: Record<string, string> | undefined;
  try {
    assetHashes = computeAssetHashes(clientDir);
    const totalAssets = Object.keys(assetHashes).length;
    const needed = await client.checkAssets(config.projectId, assetHashes);
    neededPaths = new Set(needed);
    s.message(
      `Uploading ${needed.length}/${totalAssets} assets (${totalAssets - needed.length} cached)`,
    );
  } catch {
    // No client directory — API-only project
  }

  s.message("Packaging...");
  const formData = packageBuild(
    distDir,
    workerDirName,
    bindings,
    validatedMigrations,
    schedules,
    isSsr,
    isFrameworkMode,
    neededPaths,
    assetHashes,
    headers,
    revalidate,
    envVars,
    queues,
    assetsDir,
    uniquePrerenderPaths,
  );
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const summary = [`${result.workers} worker module(s), ${result.assets} static asset(s)`];
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
    summary.push("SSR enabled");
  }
  if (revalidate) {
    if (typeof revalidate === "number") {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
  }
  if (isFrameworkMode) {
    summary.push("Framework mode");
  }
  note(summary.join("\n"), result.url);

  outro("Done!");
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
    execSync("git rev-parse --is-inside-work-tree", { cwd: root, stdio: "ignore" });
    // Check if working tree is clean
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf-8" }).trim();
    if (status !== "") return null;
    // Get current commit hash
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Detect the worker output directory name.
 * Cloudflare Vite plugin defaults worker build output to dist/<environmentName>,
 * where environmentName is workerName with "-" replaced by "_".
 * If not found, fall back to discovery for custom environment/outDir overrides.
 */
export function detectWorkerDir(root: string, distDir: string): string {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const packageName: string = pkg.name ?? "worker";
  const workerName = packageName.replace(/^@[^/]+\//, "");
  const expected = workerName.replaceAll("-", "_");

  const expectedPath = join(distDir, expected);
  if (existsSync(expectedPath)) {
    return expected;
  }

  if (!existsSync(distDir)) {
    throw new Error(`Build output not found: ${distDir}`);
  }

  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "client" && !name.startsWith("."));

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(`No worker output directory found in ${distDir}. Expected ${expectedPath}.`);
  }

  throw new Error(
    `Could not determine worker output directory in ${distDir}. Expected ${expectedPath}. Found multiple candidates: ${candidates.join(
      ", ",
    )}`,
  );
}
