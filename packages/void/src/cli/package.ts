import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { InferredBindings } from "../inference/walk";
import type { MigrationFile } from "../migrations/validate";
import type { DeployManifest, HeaderRule, QueueMeta, ScheduleMeta } from "./types";

/**
 * Compute SHA-256 hex digests for all files in a directory.
 */
export function computeAssetHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const filePath of collectFiles(dir)) {
    const rel = relative(dir, filePath);
    hashes[rel] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }
  return hashes;
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
  framework?: boolean,
  neededPaths?: Set<string>,
  assetHashes?: Record<string, string>,
  headers?: HeaderRule[],
  revalidate?: number | Record<string, number>,
  vars?: Record<string, string>,
  queues?: QueueMeta[],
  assetsDir?: string,
  prerender?: string[],
  options?: PackageOptions,
): FormData {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { version: 1, bindings: {} };
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

  if (assetsDir) {
    manifest.assetsDir = assetsDir;
  }

  if (assetHashes) {
    manifest.assetHashes = assetHashes;
  }

  if (revalidate != null && revalidate !== 0) {
    manifest.revalidate = revalidate;
  }

  if (prerender && prerender.length > 0) {
    manifest.prerender = prerender;
  }

  if (headers) {
    manifest.headers = headers;
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
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Add client assets (only needed paths when filtering)
  const clientDir = join(distDir, "client");
  try {
    const clientFiles = collectFiles(clientDir);
    for (const filePath of clientFiles) {
      const relativePath = relative(clientDir, filePath);
      if (neededPaths && !neededPaths.has(relativePath)) continue;
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
export function packageStaticBuild(
  outputDir: string,
  mode: "spa" | "ssg",
  neededPaths?: Set<string>,
  assetHashes?: Record<string, string>,
  headers?: HeaderRule[],
): FormData {
  const formData = new FormData();

  const manifest: DeployManifest = { version: 1, bindings: {}, static: mode };
  if (assetHashes) {
    manifest.assetHashes = assetHashes;
  }
  if (headers) {
    manifest.headers = headers;
  }
  formData.append("manifest", JSON.stringify(manifest));

  const files = collectFiles(outputDir);
  for (const filePath of files) {
    const relativePath = relative(outputDir, filePath);
    if (neededPaths && !neededPaths.has(relativePath)) continue;
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
  headers?: HeaderRule[];
  /** URL-level prefix for hashed/immutable assets (sets manifest.assetsDir). */
  hashedAssetsPrefix?: string;
  vars?: Record<string, string>;
  neededPaths?: Set<string>;
  assetHashes?: Record<string, string>;
  packageOptions?: PackageOptions;
}): FormData {
  const formData = new FormData();
  const po = opts.packageOptions;

  // Build manifest
  const manifest: DeployManifest = { version: 1, bindings: {} };
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
  if (opts.headers) manifest.headers = opts.headers;
  if (opts.vars && Object.keys(opts.vars).length > 0) manifest.vars = opts.vars;
  if (opts.assetHashes) manifest.assetHashes = opts.assetHashes;
  if (opts.hashedAssetsPrefix) manifest.assetsDir = opts.hashedAssetsPrefix;

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
      // Skip _headers and _redirects — already parsed into manifest
      if (relativePath === "_headers" || relativePath === "_redirects") continue;
      if (opts.neededPaths && !opts.neededPaths.has(relativePath)) continue;
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
