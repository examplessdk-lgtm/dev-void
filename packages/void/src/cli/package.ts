import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { InferredBindings } from "../inference/walk";
import type { MigrationFile } from "../migrations/validate";
import type {
  AssetConfig,
  DeployManifest,
  HeaderRule,
  QueueMeta,
  RedirectRule,
  ScheduleMeta,
} from "./types";

/**
 * Compute a CF-compatible asset hash: SHA-256, first 32 hex chars.
 * Must match the API's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

/**
 * Collect all files in a directory, compute hashes, and return both the
 * manifest (for preflight) and the raw file map (for selective packaging).
 */
export function collectAndHashAssets(dir: string): {
  assetManifest: Record<string, AssetManifestEntry>;
  assetFiles: Map<string, Buffer>;
} {
  const assetManifest: Record<string, AssetManifestEntry> = {};
  const assetFiles = new Map<string, Buffer>();

  try {
    const files = collectFiles(dir);
    for (const filePath of files) {
      const relativePath = "/" + relative(dir, filePath);
      const content = readFileSync(filePath);
      assetManifest[relativePath] = {
        hash: computeAssetHash(content),
        size: content.length,
      };
      assetFiles.set(relativePath, content);
    }
  } catch {
    // Directory doesn't exist — no assets
  }

  return { assetManifest, assetFiles };
}

/**
 * Append asset files to FormData, filtered by the set of needed paths.
 * If neededPaths is null, all assets are included (no preflight).
 */
export function appendAssets(
  formData: FormData,
  assetFiles: Map<string, Buffer>,
  neededPaths: Set<string> | null,
): void {
  for (const [path, content] of assetFiles) {
    if (neededPaths && !neededPaths.has(path)) continue;
    const key = path.startsWith("/") ? path.slice(1) : path;
    formData.append(`asset:${key}`, new Blob([new Uint8Array(content)]), key);
  }
}

/**
 * Package the build output into a FormData ready for upload.
 *
 * Build output structure:
 *   dist/
 *     <workerDir>/     ← worker output (index.js + chunks)
 *     client/          ← static SPA assets
 */
/** Optional overrides for binding names and worker metadata. */
export interface PackageOptions {
  /** Custom binding names (e.g. { d1: "MY_DB" }). Defaults: DB, KV, STORAGE. */
  bindingNames?: { d1?: string; kv?: string; r2?: string };
  /** Worker entry module filename (e.g. "index.mjs"). */
  workerMain?: string;
  /** Cloudflare compatibility_date from framework's wrangler config. */
  compatibilityDate?: string;
  /** Cloudflare compatibility_flags from framework's wrangler config. */
  compatibilityFlags?: string[];
}

export function packageBuild(
  distDir: string,
  workerDirName: string,
  bindings: InferredBindings,
  migrations?: MigrationFile[],
  schedules?: ScheduleMeta[],
  ssr?: boolean,
  framework?: string,
  revalidate?: number | Record<string, number>,
  vars?: Record<string, string>,
  queues?: QueueMeta[],
  prerender?: string[],
  assetConfig?: AssetConfig,
  options?: PackageOptions,
  neededAssets?: Set<string> | null,
  hashedAssetsPrefix?: string,
  headerRules?: HeaderRule[],
  redirectRules?: RedirectRule[],
): FormData {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { version: 3, bindings: {} };
  if (bindings.needsD1) manifest.bindings.d1 = [options?.bindingNames?.d1 ?? "DB"];
  if (bindings.needsKV) manifest.bindings.kv = [options?.bindingNames?.kv ?? "KV"];
  if (bindings.needsR2) manifest.bindings.r2 = [options?.bindingNames?.r2 ?? "STORAGE"];
  if (bindings.needsAI) manifest.bindings.ai = true;
  if (bindings.needsAuth) {
    manifest.bindings.kv ??= [];
    if (!manifest.bindings.kv.includes("AUTH_KV")) manifest.bindings.kv.push("AUTH_KV");
  }

  // Add migration metadata to manifest + SQL content as FormData entries
  if (migrations && migrations.length > 0) {
    manifest.migrations = {
      dialect: "sqlite",
      pending: migrations.length,
    };
    for (const m of migrations) {
      formData.append(`migration:${m.name}`, new Blob([m.sql]), m.name);
    }
  }

  if (schedules && schedules.length > 0) {
    manifest.schedules = schedules;
  }

  if (queues && queues.length > 0) {
    manifest.queues = queues;
  }

  if (ssr) {
    manifest.ssr = true;
  }

  if (framework) {
    manifest.framework = framework;
  }

  manifest.type = framework ? "framework" : "void";

  if (revalidate != null && revalidate !== 0) {
    manifest.revalidate = revalidate;
  }

  if (prerender && prerender.length > 0) {
    manifest.prerender = prerender;
  }

  if (assetConfig) {
    manifest.assetConfig = assetConfig;
  }

  if (vars && Object.keys(vars).length > 0) {
    manifest.vars = vars;
  }

  if (options?.workerMain) {
    manifest.workerMain = options.workerMain;
  }
  if (options?.compatibilityDate) {
    manifest.compatibilityDate = options.compatibilityDate;
  }
  if (options?.compatibilityFlags && options.compatibilityFlags.length > 0) {
    manifest.compatibilityFlags = options.compatibilityFlags;
  }

  if (hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = hashedAssetsPrefix;
  }

  if (headerRules && headerRules.length > 0) {
    manifest.headerRules = headerRules;
  }

  if (redirectRules && redirectRules.length > 0) {
    manifest.redirectRules = redirectRules;
  }

  formData.append("manifest", JSON.stringify(manifest));

  // Add worker files
  const workerDir = join(distDir, workerDirName);
  const workerFiles = collectFiles(workerDir);
  for (const filePath of workerFiles) {
    const relativePath = relative(workerDir, filePath);
    if (!isWorkerModule(relativePath)) continue;
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Add client assets
  const clientDir = join(distDir, "client");
  try {
    const clientFiles = collectFiles(clientDir);
    for (const filePath of clientFiles) {
      const relativePath = relative(clientDir, filePath);
      if (neededAssets && !neededAssets.has("/" + relativePath)) continue;
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No client directory — API-only project
  }

  if (neededAssets) formData.append("preflight", "true");

  return formData;
}

/**
 * Package a static build (no worker) into a FormData ready for upload.
 */
export function packageStaticBuild(
  outputDir: string,
  appType: "spa" | "static",
  neededAssets?: Set<string> | null,
  hashedAssetsPrefix?: string,
  headerRules?: HeaderRule[],
  redirectRules?: RedirectRule[],
): FormData {
  const formData = new FormData();

  const manifest: DeployManifest = {
    version: 3,
    bindings: {},
    type: appType,
    assetConfig: {
      not_found_handling: appType === "spa" ? "single-page-application" : "404-page",
    },
  };

  if (hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = hashedAssetsPrefix;
  }

  if (headerRules && headerRules.length > 0) {
    manifest.headerRules = headerRules;
  }

  if (redirectRules && redirectRules.length > 0) {
    manifest.redirectRules = redirectRules;
  }

  formData.append("manifest", JSON.stringify(manifest));

  const files = collectFiles(outputDir);
  for (const filePath of files) {
    const relativePath = relative(outputDir, filePath);
    if (neededAssets && !neededAssets.has("/" + relativePath)) continue;
    const content = readFileSync(filePath);
    formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
  }

  if (neededAssets) formData.append("preflight", "true");

  return formData;
}

/**
 * Package a framework build (Class B/C) into a FormData ready for upload.
 *
 * Unlike `packageBuild`, the worker and assets directories are absolute paths
 * (resolved from the project root + preset), and the worker directory may be
 * inside the assets directory (SvelteKit, Astro). Worker files are excluded
 * from asset collection when directories overlap.
 */
export function packageFrameworkBuild(opts: {
  frameworkName: string;
  workerDir: string;
  workerMain: string;
  assetsDir: string;
  bindings: InferredBindings;
  migrations?: MigrationFile[];
  schedules?: ScheduleMeta[];
  queues?: QueueMeta[];
  revalidate?: number | Record<string, number>;
  prerender?: string[];
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  packageOptions?: PackageOptions;
  neededAssets?: Set<string> | null;
  hashedAssetsPrefix?: string;
  headerRules?: HeaderRule[];
  redirectRules?: RedirectRule[];
}): FormData {
  const formData = new FormData();
  const po = opts.packageOptions;

  // Build manifest
  const manifest: DeployManifest = { version: 3, bindings: {} };
  if (opts.bindings.needsD1) manifest.bindings.d1 = [po?.bindingNames?.d1 ?? "DB"];
  if (opts.bindings.needsKV) manifest.bindings.kv = [po?.bindingNames?.kv ?? "KV"];
  if (opts.bindings.needsR2) manifest.bindings.r2 = [po?.bindingNames?.r2 ?? "STORAGE"];
  if (opts.bindings.needsAI) manifest.bindings.ai = true;
  if (opts.bindings.needsAuth) {
    manifest.bindings.kv ??= [];
    if (!manifest.bindings.kv.includes("AUTH_KV")) manifest.bindings.kv.push("AUTH_KV");
  }

  if (opts.migrations && opts.migrations.length > 0) {
    manifest.migrations = {
      dialect: "sqlite",
      pending: opts.migrations.length,
    };
    for (const m of opts.migrations) {
      formData.append(`migration:${m.name}`, new Blob([m.sql]), m.name);
    }
  }

  if (opts.schedules && opts.schedules.length > 0) manifest.schedules = opts.schedules;
  if (opts.queues && opts.queues.length > 0) manifest.queues = opts.queues;
  if (opts.revalidate != null && opts.revalidate !== 0) manifest.revalidate = opts.revalidate;
  if (opts.prerender && opts.prerender.length > 0) manifest.prerender = opts.prerender;
  if (opts.assetConfig) manifest.assetConfig = opts.assetConfig;
  if (opts.vars && Object.keys(opts.vars).length > 0) manifest.vars = opts.vars;

  manifest.ssr = true;
  manifest.framework = opts.frameworkName;
  manifest.type = "framework";
  manifest.workerMain = po?.workerMain ?? opts.workerMain;
  if (po?.compatibilityDate) manifest.compatibilityDate = po.compatibilityDate;
  if (po?.compatibilityFlags && po.compatibilityFlags.length > 0) {
    manifest.compatibilityFlags = po.compatibilityFlags;
  }

  if (opts.hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = opts.hashedAssetsPrefix;
  }

  if (opts.headerRules && opts.headerRules.length > 0) {
    manifest.headerRules = opts.headerRules;
  }

  if (opts.redirectRules && opts.redirectRules.length > 0) {
    manifest.redirectRules = opts.redirectRules;
  }

  formData.append("manifest", JSON.stringify(manifest));

  // Collect worker files and asset files, handling directory overlap
  const workerDirNorm = opts.workerDir.replace(/\\/g, "/");
  const assetsDirNorm = opts.assetsDir.replace(/\\/g, "/");
  const isOverlap =
    workerDirNorm.startsWith(assetsDirNorm + "/") || workerDirNorm === assetsDirNorm;

  // Worker files
  const workerFiles = collectFiles(opts.workerDir);
  for (const filePath of workerFiles) {
    const relativePath = relative(opts.workerDir, filePath);
    if (!isWorkerModule(relativePath)) continue;
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Asset files
  try {
    const assetFiles = collectFiles(opts.assetsDir);
    for (const filePath of assetFiles) {
      // Skip worker files when workerDir overlaps with assetsDir
      if (isOverlap && filePath.replace(/\\/g, "/").startsWith(workerDirNorm)) continue;
      const relativePath = relative(opts.assetsDir, filePath);
      if (opts.neededAssets && !opts.neededAssets.has("/" + relativePath)) continue;
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No assets directory
  }

  if (opts.neededAssets) formData.append("preflight", "true");

  return formData;
}

/**
 * Check if a file (by relative path) should be included as a worker module.
 * Skips build metadata and files with extensions CF Workers can't handle as modules.
 */
function isWorkerModule(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, "/");
  // Skip build metadata at any depth
  if (norm.includes("/.vite/") || norm.startsWith(".vite/")) return false;
  // Skip wrangler config
  if (norm === "wrangler.json" || norm === "wrangler.jsonc") return false;
  // Only include CF-compatible module extensions
  return /\.(js|mjs|cjs|wasm|map|txt)$/.test(norm);
}

/**
 * Recursively collect all file paths in a directory.
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
