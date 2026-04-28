import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { hash as blake3hash } from 'blake3-jit';
import ignore from 'ignore';
import type { InferredBindings } from '../inference/walk';
import type { MigrationFile } from '../migrations/validate';
import type { WebSocketRouteDefinition } from '../router/websocket';
import type { ResolvedSandboxConfig } from '../sandbox/config';
import { toSlash } from '../shared/utils';
import type {
  AssetConfig,
  DeployManifest,
  DevRedirectRule,
  HeaderRule,
  QueueMeta,
  RedirectRule,
  SandboxManifestMeta,
  ScheduleMeta,
  WebSocketManifestMeta,
} from './types';

const textEncoder = new TextEncoder();

type ProgressCallback = (message: string) => void;

/**
 * Strip dev-only / internal-only fields from each rule before shipping the
 * manifest. The resulting entries contain only `{ source, destination, status }`.
 *
 * - `origin` is used to build the `X-Void-Routing` trace header during local
 *   dev; the deployed platform doesn't consume it.
 * - `force` is used internally by the CLI/router to split rules into the
 *   `redirectRules` (pre-asset, always-fires) and `fallbackRules` (post-asset,
 *   only when the asset resolver 404s) buckets and to label the trace header
 *   on `node`/`bun`/`deno` targets. The platform dispatch worker decides phase
 *   purely from which array the rule lives in, so shipping `force` is dead weight.
 *
 * Keep in sync with `stripOriginForProd` in `router/compile.ts`, which strips
 * only `origin` because the Node/Bun/Deno-target generated code still reads
 * `force` at runtime to label the dev trace header.
 */
function stripDevOnlyRuleFields(
  rules: Array<DevRedirectRule> | undefined,
): Array<RedirectRule> | undefined {
  if (!rules) {
    return rules;
  }
  return rules.map(({ origin: _origin, force: _force, ...rest }) => rest);
}

/**
 * Layer user-defined `routing.fallbacks` with the SPA app type's implicit
 * `/index.html` fallback. Decision: user fallbacks take precedence; if none
 * matches, the SPA default kicks in.
 *
 * The platform's `not_found_handling: 'single-page-application'` is a global
 * switch — set once per deployment — so we can't have the platform evaluate
 * user fallbacks *before* applying it. Instead, when the user has configured
 * fallbacks on a SPA app, we disable the platform-level SPA setting and
 * prepend a synthetic catch-all fallback rule (`/*` → `/index.html`) before
 * the user's rules. The dispatch worker evaluates fallback rules with
 * last-match-wins semantics, so placing the synthetic rule first means any
 * user rule that matches a more specific pattern overrides it; the synthetic
 * rule only fires when no user rule matched.
 *
 * When the user has no fallbacks configured, the platform-level SPA switch
 * is left intact (zero worker-side overhead for the common case).
 */
export function resolveSpaFallbackChain(
  appType: 'spa' | 'static' | undefined,
  fallbackRules: Array<DevRedirectRule> | undefined,
): {
  assetConfig: AssetConfig;
  fallbackRules: Array<DevRedirectRule> | undefined;
} {
  const userRules = fallbackRules && fallbackRules.length > 0 ? fallbackRules : undefined;

  if (appType !== 'spa') {
    return {
      assetConfig: { not_found_handling: appType === 'static' ? '404-page' : 'none' },
      fallbackRules: userRules,
    };
  }

  if (!userRules) {
    // No user fallbacks — keep the zero-overhead platform SPA switch.
    return {
      assetConfig: { not_found_handling: 'single-page-application' },
      fallbackRules: undefined,
    };
  }

  // User fallbacks present on a SPA app — disable the platform-level SPA
  // switch and prepend a synthetic catch-all rule before user rules, so that
  // under last-match-wins any more specific user rule overrides it. If the
  // user already has `/*` → `/index.html`, skip the prepend so we don't ship
  // two identical rules (which would trip the duplicate-source lint).
  const alreadyHasCatchAll = userRules.some(
    (r) => r.source === '/*' && r.destination === '/index.html',
  );
  if (alreadyHasCatchAll) {
    return { assetConfig: { not_found_handling: 'none' }, fallbackRules: userRules };
  }
  const syntheticSpaFallback: DevRedirectRule = {
    source: '/*',
    destination: '/index.html',
    status: 200,
    force: false,
    origin: 'spa-default',
  };
  return {
    assetConfig: { not_found_handling: 'none' },
    fallbackRules: [syntheticSpaFallback, ...userRules],
  };
}

const PROGRESS_CHUNK = 50;

/**
 * Yield to the event loop every PROGRESS_CHUNK iterations so spinner ticks
 * can repaint, and emit a progress message via onProgress. Otherwise the
 * tight sync loop blocks the spinner interval and the user sees no updates.
 */
async function tickProgress(
  i: number,
  total: number,
  onProgress: ProgressCallback | undefined,
  label: string,
): Promise<void> {
  if (!onProgress) {
    return;
  }
  if (i % PROGRESS_CHUNK !== 0 && i !== total) {
    return;
  }
  onProgress(`${label} (${i}/${total})`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Compute a CF-compatible asset hash: BLAKE3 of base64(content) + extension,
 * first 32 hex chars. Matches Wrangler's hashFile algorithm exactly.
 * Must match the API's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: Buffer, filePath: string): string {
  const base64 = content.toString('base64');
  const ext = extname(filePath).substring(1);
  const input = textEncoder.encode(base64 + ext);
  return Buffer.from(blake3hash(input)).toString('hex').slice(0, 32);
}

/**
 * Create a filter function that excludes .assetsignore, _headers, _redirects,
 * and any patterns listed in a .assetsignore file. Matches Wrangler's
 * createAssetsIgnoreFunction from workers-shared/utils/helpers.ts.
 */
function createAssetsIgnoreFunction(dir: string): {
  isIgnored: (relativePath: string) => boolean;
  assetsIgnoreFilePresent: boolean;
} {
  const patterns = ['/.assetsignore', '/_redirects', '/_headers'];
  const assetsIgnorePath = join(dir, '.assetsignore');
  let assetsIgnoreFilePresent = false;
  if (existsSync(assetsIgnorePath)) {
    assetsIgnoreFilePresent = true;
    const content = readFileSync(assetsIgnorePath, 'utf-8');
    patterns.push(...content.split('\n'));
  }
  const ig = ignore().add(patterns);
  // ignore library expects relative paths without leading /
  const isIgnored = (relativePath: string) => {
    const normalized = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return ig.test(normalized).ignored;
  };
  return { isIgnored, assetsIgnoreFilePresent };
}

/**
 * Guard against accidentally uploading _worker.js as a static asset.
 * Matches Wrangler's errorOnLegacyPagesWorkerJSAsset behavior:
 * throws only when no .assetsignore file exists (if .assetsignore is present
 * but doesn't exclude _worker.js, the user intentionally wants to upload it).
 */
function checkWorkerJsAsset(relativePath: string, assetsIgnoreFilePresent: boolean): void {
  if (assetsIgnoreFilePresent) {
    return;
  }
  const name = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  if (name === '_worker.js' || name.startsWith('_worker.js/')) {
    const type = name === '_worker.js' ? 'file' : 'directory';
    throw new Error(
      `deploy: Refusing to upload _worker.js ${type} as an asset. ` +
        `This could expose private server-side code to the public Internet. ` +
        `If this is unintended, remove it or add a .assetsignore file containing "_worker.js". ` +
        `If intentional, add an empty .assetsignore file to suppress this error.`,
    );
  }
}

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

/**
 * Collect all files in a directory, compute hashes, and return both the
 * manifest (for preflight) and the raw file map (for selective packaging).
 */
export async function collectAndHashAssets(
  dir: string,
  onProgress?: ProgressCallback,
): Promise<{
  assetManifest: Record<string, AssetManifestEntry>;
  assetFiles: Map<string, Buffer>;
}> {
  const assetManifest: Record<string, AssetManifestEntry> = {};
  const assetFiles = new Map<string, Buffer>();

  try {
    const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(dir);
    const files = collectFiles(dir);
    let processed = 0;
    for (const filePath of files) {
      processed++;
      await tickProgress(processed, files.length, onProgress, 'Hashing assets');
      const relativePath = '/' + toSlash(relative(dir, filePath));
      if (isIgnored(relativePath)) {
        continue;
      }
      checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
      const content = readFileSync(filePath);
      assetManifest[relativePath] = {
        hash: computeAssetHash(content, filePath),
        size: content.length,
      };
      assetFiles.set(relativePath, content);
    }
  } catch (err) {
    // Only swallow directory-not-found errors; re-throw everything else
    // (e.g. _worker.js safety guard)
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory doesn't exist — no assets
    } else {
      throw err;
    }
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
    if (neededPaths && !neededPaths.has(path)) {
      continue;
    }
    const key = path.startsWith('/') ? path.slice(1) : path;
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
  bindingNames?: { d1?: string; kv?: string; r2?: string; sandbox?: string };
  /** Worker entry module filename (e.g. "index.mjs"). */
  workerMain?: string;
  /** Cloudflare compatibility_date from framework's wrangler config. */
  compatibilityDate?: string;
  /** Cloudflare compatibility_flags from framework's wrangler config. */
  compatibilityFlags?: Array<string>;
  /** Cloudflare Sandbox container metadata for platform deploys. */
  sandbox?: ResolvedSandboxConfig;
  /** Query params that participate in ISR variant keys for dispatch rewrites. */
  revalidateQueryAllowlist?: Record<string, Array<string>>;
}

function toWebSocketManifest(
  routes: Array<WebSocketRouteDefinition> | undefined,
): WebSocketManifestMeta | undefined {
  if (!routes || routes.length === 0) {
    return undefined;
  }
  return {
    routes: routes.map((route) => ({
      pattern: route.pattern,
      filePath: route.filePath,
      className: route.className,
      mode: route.mode,
      hasAuthGate: route.hasAuthGate,
    })),
    classes: routes.map((route) => route.className),
  };
}

function toSandboxManifest(sandbox: ResolvedSandboxConfig): SandboxManifestMeta {
  return {
    bindingName: sandbox.binding,
    className: sandbox.className,
    containerName: sandbox.containerName,
    image: sandbox.platformImage,
    ...(sandbox.instanceType && { instanceType: sandbox.instanceType }),
    ...(sandbox.maxInstances != null && { maxInstances: sandbox.maxInstances }),
  };
}

export async function packageBuild(
  distDir: string,
  workerDirName: string,
  bindings: InferredBindings,
  migrations?: Array<MigrationFile>,
  schedules?: Array<ScheduleMeta>,
  ssr?: boolean,
  framework?: string,
  revalidate?: number | Record<string, number>,
  vars?: Record<string, string>,
  queues?: Array<QueueMeta>,
  prerender?: Array<string>,
  assetConfig?: AssetConfig,
  options?: PackageOptions,
  neededAssets?: Set<string> | null,
  hashedAssetsPrefix?: string,
  headerRules?: Array<HeaderRule>,
  redirectRules?: Array<DevRedirectRule>,
  fallbackRules?: Array<DevRedirectRule>,
  dialect?: 'sqlite' | 'postgresql',
  webSockets?: Array<WebSocketRouteDefinition>,
  onProgress?: ProgressCallback,
): Promise<FormData> {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { version: 3, bindings: {} };
  if (bindings.needsAuth) {
    manifest.auth = true;
  }
  const hasMigrations = migrations && migrations.length > 0;
  if (bindings.needsD1 || bindings.needsAuth || hasMigrations) {
    if (dialect === 'postgresql') {
      manifest.bindings.hyperdrive = ['HYPERDRIVE'];
    } else {
      manifest.bindings.d1 = [options?.bindingNames?.d1 ?? 'DB'];
    }
  }
  if (bindings.needsKV) {
    manifest.bindings.kv = [options?.bindingNames?.kv ?? 'KV'];
  }
  if (bindings.needsR2) {
    manifest.bindings.r2 = [options?.bindingNames?.r2 ?? 'STORAGE'];
  }
  if (bindings.needsAI) {
    manifest.bindings.ai = true;
  }
  if (bindings.needsSandbox) {
    if (!options?.sandbox) {
      throw new Error('deploy: Sandbox bindings require sandbox package options.');
    }
    manifest.sandbox = toSandboxManifest({
      ...options.sandbox,
      binding: options.bindingNames?.sandbox ?? options.sandbox.binding,
    });
  }

  // Add migration metadata to manifest + SQL content as FormData entries
  if (migrations && migrations.length > 0) {
    manifest.migrations = {
      dialect: dialect ?? 'sqlite',
      pending: migrations.length,
    };
    onProgress?.(
      `Packaging ${migrations.length} migration${migrations.length === 1 ? '' : 's'}...`,
    );
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

  manifest.type = framework ? 'framework' : 'void';

  if (revalidate != null && revalidate !== 0) {
    manifest.revalidate = revalidate;
  }
  if (
    options?.revalidateQueryAllowlist &&
    Object.keys(options.revalidateQueryAllowlist).length > 0
  ) {
    manifest.revalidateQueryAllowlist = options.revalidateQueryAllowlist;
  }

  if (prerender && prerender.length > 0) {
    manifest.prerender = prerender;
  }

  // Layer user fallbacks with the SPA default (if applicable). When the
  // caller signals SPA mode via `not_found_handling: 'single-page-application'`
  // and the user has `routing.fallbacks` configured, we disable the
  // platform-level SPA switch and append a synthetic catch-all rule so user
  // fallbacks are evaluated first and the SPA default only fires when none
  // matched.
  let resolvedAssetConfig = assetConfig;
  let resolvedFallbackRules = fallbackRules;
  if (assetConfig?.not_found_handling === 'single-page-application') {
    const chain = resolveSpaFallbackChain('spa', fallbackRules);
    resolvedAssetConfig = { ...assetConfig, ...chain.assetConfig };
    resolvedFallbackRules = chain.fallbackRules;
  } else if (fallbackRules && fallbackRules.length > 0) {
    // Fallbacks ship for any app type, but the SPA-shell chain (prepending
    // `/* -> /index.html`) only runs when `not_found_handling` is
    // `single-page-application`. On SSR / Void / framework apps, user
    // fallbacks still fire post-lookup, but no SPA shell is synthesised —
    // callers relying on the rules to provide an `/index.html` safety net
    // will hit the platform's default 404 on unmatched paths. Warn so the
    // expectation mismatch surfaces at build time.
    const msg =
      `routing.fallbacks is set but appType is not "spa"; fallbacks will be applied, ` +
      `but no "/* -> /index.html" SPA shell fallback is synthesised — unmatched paths fall through to the platform 404.`;
    onProgress?.(msg);
    console.warn(`[void] ${msg}`);
  }

  if (resolvedAssetConfig) {
    manifest.assetConfig = resolvedAssetConfig;
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
    manifest.redirectRules = stripDevOnlyRuleFields(redirectRules);
  }

  if (resolvedFallbackRules && resolvedFallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(resolvedFallbackRules);
  }

  const websocketManifest = toWebSocketManifest(webSockets);
  if (websocketManifest) {
    manifest.websocket = websocketManifest;
  }

  formData.append('manifest', JSON.stringify(manifest));

  // Add worker files
  onProgress?.('Packaging worker files...');
  const workerDir = join(distDir, workerDirName);
  const workerFiles = collectFiles(workerDir);
  for (const filePath of workerFiles) {
    const relativePath = toSlash(relative(workerDir, filePath));
    if (!isWorkerModule(relativePath)) {
      continue;
    }
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Add client assets
  const clientDir = join(distDir, 'client');
  try {
    const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(clientDir);
    const clientFiles = collectFiles(clientDir);
    let processed = 0;
    for (const filePath of clientFiles) {
      processed++;
      await tickProgress(processed, clientFiles.length, onProgress, 'Packaging assets');
      const relativePath = toSlash(relative(clientDir, filePath));
      if (isIgnored('/' + relativePath)) {
        continue;
      }
      checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
      if (neededAssets && !neededAssets.has('/' + relativePath)) {
        continue;
      }
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No client directory — API-only project
    } else {
      throw err;
    }
  }

  if (neededAssets) {
    formData.append('preflight', 'true');
  }

  return formData;
}

/**
 * Package a static build (no worker) into a FormData ready for upload.
 */
export async function packageStaticBuild(
  outputDir: string,
  appType: 'spa' | 'static',
  neededAssets?: Set<string> | null,
  hashedAssetsPrefix?: string,
  headerRules?: Array<HeaderRule>,
  redirectRules?: Array<DevRedirectRule>,
  fallbackRules?: Array<DevRedirectRule>,
  onProgress?: ProgressCallback,
): Promise<FormData> {
  const formData = new FormData();

  const { assetConfig, fallbackRules: resolvedFallbackRules } = resolveSpaFallbackChain(
    appType,
    fallbackRules,
  );

  const manifest: DeployManifest = {
    version: 3,
    bindings: {},
    type: appType,
    assetConfig,
  };

  if (hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = hashedAssetsPrefix;
  }

  if (headerRules && headerRules.length > 0) {
    manifest.headerRules = headerRules;
  }

  if (redirectRules && redirectRules.length > 0) {
    manifest.redirectRules = stripDevOnlyRuleFields(redirectRules);
  }

  if (resolvedFallbackRules && resolvedFallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(resolvedFallbackRules);
  }

  formData.append('manifest', JSON.stringify(manifest));

  const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(outputDir);
  const files = collectFiles(outputDir);
  let processed = 0;
  for (const filePath of files) {
    processed++;
    await tickProgress(processed, files.length, onProgress, 'Packaging assets');
    const relativePath = toSlash(relative(outputDir, filePath));
    if (isIgnored('/' + relativePath)) {
      continue;
    }
    checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
    if (neededAssets && !neededAssets.has('/' + relativePath)) {
      continue;
    }
    const content = readFileSync(filePath);
    formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
  }

  if (neededAssets) {
    formData.append('preflight', 'true');
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
export async function packageFrameworkBuild(opts: {
  frameworkName: string;
  workerDir: string;
  workerMain: string;
  assetsDir: string;
  bindings: InferredBindings;
  migrations?: Array<MigrationFile>;
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  packageOptions?: PackageOptions;
  neededAssets?: Set<string> | null;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  dialect?: 'sqlite' | 'postgresql';
  webSockets?: Array<WebSocketRouteDefinition>;
  onProgress?: ProgressCallback;
}): Promise<FormData> {
  const formData = new FormData();
  const po = opts.packageOptions;

  // Build manifest
  const manifest: DeployManifest = { version: 3, bindings: {} };
  const hasMigrations = opts.migrations && opts.migrations.length > 0;
  if (opts.bindings.needsD1 || opts.bindings.needsAuth || hasMigrations) {
    if (opts.dialect === 'postgresql') {
      manifest.bindings.hyperdrive = ['HYPERDRIVE'];
    } else {
      manifest.bindings.d1 = [po?.bindingNames?.d1 ?? 'DB'];
    }
  }
  if (opts.bindings.needsKV) {
    manifest.bindings.kv = [po?.bindingNames?.kv ?? 'KV'];
  }
  if (opts.bindings.needsR2) {
    manifest.bindings.r2 = [po?.bindingNames?.r2 ?? 'STORAGE'];
  }
  if (opts.bindings.needsAI) {
    manifest.bindings.ai = true;
  }

  if (opts.migrations && opts.migrations.length > 0) {
    manifest.migrations = {
      dialect: opts.dialect ?? 'sqlite',
      pending: opts.migrations.length,
    };
    opts.onProgress?.(
      `Packaging ${opts.migrations.length} migration${opts.migrations.length === 1 ? '' : 's'}...`,
    );
    for (const m of opts.migrations) {
      formData.append(`migration:${m.name}`, new Blob([m.sql]), m.name);
    }
  }

  if (opts.schedules && opts.schedules.length > 0) {
    manifest.schedules = opts.schedules;
  }
  if (opts.queues && opts.queues.length > 0) {
    manifest.queues = opts.queues;
  }
  if (opts.revalidate != null && opts.revalidate !== 0) {
    manifest.revalidate = opts.revalidate;
  }
  if (opts.revalidateQueryAllowlist && Object.keys(opts.revalidateQueryAllowlist).length > 0) {
    manifest.revalidateQueryAllowlist = opts.revalidateQueryAllowlist;
  }
  if (opts.prerender && opts.prerender.length > 0) {
    manifest.prerender = opts.prerender;
  }
  if (opts.assetConfig) {
    manifest.assetConfig = opts.assetConfig;
  }
  if (opts.vars && Object.keys(opts.vars).length > 0) {
    manifest.vars = opts.vars;
  }

  manifest.ssr = true;
  manifest.framework = opts.frameworkName;
  manifest.type = 'framework';
  manifest.workerMain = po?.workerMain ?? opts.workerMain;
  if (po?.compatibilityDate) {
    manifest.compatibilityDate = po.compatibilityDate;
  }
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
    manifest.redirectRules = stripDevOnlyRuleFields(opts.redirectRules);
  }

  if (opts.fallbackRules && opts.fallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(opts.fallbackRules);
  }

  const websocketManifest = toWebSocketManifest(opts.webSockets);
  if (websocketManifest) {
    manifest.websocket = websocketManifest;
  }

  formData.append('manifest', JSON.stringify(manifest));

  // Collect worker files and asset files, handling directory overlap
  const workerDirNorm = opts.workerDir.replace(/\\/g, '/');
  const assetsDirNorm = opts.assetsDir.replace(/\\/g, '/');
  const isOverlap =
    workerDirNorm.startsWith(assetsDirNorm + '/') || workerDirNorm === assetsDirNorm;

  // Worker files
  opts.onProgress?.('Packaging worker files...');
  const workerFiles = collectFiles(opts.workerDir);
  for (const filePath of workerFiles) {
    const relativePath = toSlash(relative(opts.workerDir, filePath));
    if (!isWorkerModule(relativePath)) {
      continue;
    }
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Asset files
  try {
    const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(opts.assetsDir);
    const assetFiles = collectFiles(opts.assetsDir);
    let processed = 0;
    for (const filePath of assetFiles) {
      processed++;
      await tickProgress(processed, assetFiles.length, opts.onProgress, 'Packaging assets');
      // Skip worker files when workerDir overlaps with assetsDir
      if (isOverlap && filePath.replace(/\\/g, '/').startsWith(workerDirNorm)) {
        continue;
      }
      const relativePath = toSlash(relative(opts.assetsDir, filePath));
      if (isIgnored('/' + relativePath)) {
        continue;
      }
      checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
      if (opts.neededAssets && !opts.neededAssets.has('/' + relativePath)) {
        continue;
      }
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No assets directory
    } else {
      throw err;
    }
  }

  if (opts.neededAssets) {
    formData.append('preflight', 'true');
  }

  return formData;
}

/**
 * Check if a file (by relative path) should be included as a worker module.
 * Skips build metadata and files with extensions CF Workers can't handle as modules.
 */
function isWorkerModule(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/');
  // Skip build metadata at any depth
  if (norm.includes('/.vite/') || norm.startsWith('.vite/')) {
    return false;
  }
  // Skip wrangler config
  if (norm === 'wrangler.json' || norm === 'wrangler.jsonc') {
    return false;
  }
  // Only include CF-compatible module extensions
  return /\.(js|mjs|cjs|wasm|map|txt)$/.test(norm);
}

/**
 * Recursively collect all file paths in a directory.
 */
function collectFiles(dir: string): Array<string> {
  const files: Array<string> = [];
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
