import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { InferredBindings } from "../inference/walk";
import type { MigrationFile } from "../migrations/validate";
import type { AssetConfig, DeployManifest, QueueMeta, ScheduleMeta } from "./types";

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
  framework?: boolean,
  revalidate?: number | Record<string, number>,
  vars?: Record<string, string>,
  queues?: QueueMeta[],
  prerender?: string[],
  assetConfig?: AssetConfig,
  options?: PackageOptions,
): FormData {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { version: 2, bindings: {} };
  if (bindings.needsD1) manifest.bindings.d1 = [options?.bindingNames?.d1 ?? "DB"];
  if (bindings.needsKV) manifest.bindings.kv = [options?.bindingNames?.kv ?? "KV"];
  if (bindings.needsR2) manifest.bindings.r2 = [options?.bindingNames?.r2 ?? "STORAGE"];
  if (bindings.needsAI) manifest.bindings.ai = true;

  // Add migration metadata to manifest + SQL content as FormData entries
  if (migrations && migrations.length > 0) {
    manifest.migrations = migrations.map((m) => ({
      name: m.name,
      destructive: m.destructive,
    }));
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
    manifest.framework = true;
  }

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

  formData.append("manifest", JSON.stringify(manifest));

  // Add worker files
  const workerDir = join(distDir, workerDirName);
  const workerFiles = collectFiles(workerDir);
  for (const filePath of workerFiles) {
    const relativePath = relative(workerDir, filePath);
    // Skip wrangler.json — platform manages worker config
    if (relativePath === "wrangler.json") continue;
    // Skip .vite/ build metadata (manifest.json etc.) — not runtime code
    if (relativePath.startsWith(".vite/") || relativePath.startsWith(".vite\\")) continue;
    // Skip CSS files — Vite extracts them during SSR build but they're only
    // needed on the client side. Uploading them as worker modules causes
    // Cloudflare to reject the deploy (SyntaxError parsing CSS as JS).
    if (relativePath.endsWith(".css")) continue;
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Add client assets
  const clientDir = join(distDir, "client");
  try {
    const clientFiles = collectFiles(clientDir);
    for (const filePath of clientFiles) {
      const relativePath = relative(clientDir, filePath);
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No client directory — API-only project
  }

  return formData;
}

/**
 * Package a static build (no worker) into a FormData ready for upload.
 */
export function packageStaticBuild(outputDir: string, appType: "spa" | "prebuilt"): FormData {
  const formData = new FormData();

  const manifest: DeployManifest = {
    version: 2,
    bindings: {},
    assetConfig: {
      not_found_handling: appType === "spa" ? "single-page-application" : "404-page",
    },
  };
  formData.append("manifest", JSON.stringify(manifest));

  const files = collectFiles(outputDir);
  for (const filePath of files) {
    const relativePath = relative(outputDir, filePath);
    const content = readFileSync(filePath);
    formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
  }

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
}): FormData {
  const formData = new FormData();
  const po = opts.packageOptions;

  // Build manifest
  const manifest: DeployManifest = { version: 2, bindings: {} };
  if (opts.bindings.needsD1) manifest.bindings.d1 = [po?.bindingNames?.d1 ?? "DB"];
  if (opts.bindings.needsKV) manifest.bindings.kv = [po?.bindingNames?.kv ?? "KV"];
  if (opts.bindings.needsR2) manifest.bindings.r2 = [po?.bindingNames?.r2 ?? "STORAGE"];
  if (opts.bindings.needsAI) manifest.bindings.ai = true;

  if (opts.migrations && opts.migrations.length > 0) {
    manifest.migrations = opts.migrations.map((m) => ({
      name: m.name,
      destructive: m.destructive,
    }));
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
  manifest.framework = true;
  manifest.workerMain = po?.workerMain ?? opts.workerMain;
  if (po?.compatibilityDate) manifest.compatibilityDate = po.compatibilityDate;
  if (po?.compatibilityFlags && po.compatibilityFlags.length > 0) {
    manifest.compatibilityFlags = po.compatibilityFlags;
  }

  formData.append("manifest", JSON.stringify(manifest));

  // Collect worker files
  const workerFiles = collectFiles(opts.workerDir);
  for (const filePath of workerFiles) {
    const relativePath = relative(opts.workerDir, filePath);
    if (relativePath === "wrangler.json" || relativePath === "wrangler.jsonc") continue;
    if (relativePath.startsWith(".vite/") || relativePath.startsWith(".vite\\")) continue;
    if (relativePath.endsWith(".css")) continue;
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Collect asset files, excluding worker dir when it overlaps
  const workerDirNorm = opts.workerDir.replace(/\\/g, "/");
  const assetsDirNorm = opts.assetsDir.replace(/\\/g, "/");
  const isOverlap =
    workerDirNorm.startsWith(assetsDirNorm + "/") || workerDirNorm === assetsDirNorm;

  try {
    const assetFiles = collectFiles(opts.assetsDir);
    for (const filePath of assetFiles) {
      // Skip worker files when workerDir is inside assetsDir
      if (isOverlap && filePath.replace(/\\/g, "/").startsWith(workerDirNorm)) continue;
      const relativePath = relative(opts.assetsDir, filePath);
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No assets directory
  }

  return formData;
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
