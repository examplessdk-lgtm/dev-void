import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hash as blake3hash } from 'blake3-jit';
import ignore from 'ignore';
import { extname, join, relative } from 'pathe';
import type { InferredBindings } from '../inference/walk.ts';
import { buildMigrationPlanBundle } from '../migrations/plan.ts';
import type { MigrationFile } from '../migrations/validate.ts';
import type { WebSocketRouteDefinition } from '../router/websocket.ts';
import type { ResolvedSandboxConfig } from '../sandbox/config.ts';
import { toSlash } from '../shared/utils.ts';
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
} from './types.ts';
import {
  DEFAULT_LIVE_BINDING,
  DEFAULT_LIVE_CLASS,
  LIVE_MIGRATION_TAG,
  type LiveBindingConfig,
} from './wrangler.ts';

const textEncoder = new TextEncoder();

type ProgressCallback = (message: string) => void;

const FRAMEWORK_LIVE_UNSUPPORTED_MESSAGE =
  'deploy: void/live is currently supported in Void apps only.';

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
 * append a synthetic catch-all fallback rule (`/*` → `/index.html`) after
 * the user's rules. The dispatch worker evaluates routing rules with
 * first-match-wins semantics, so placing the synthetic rule last means any
 * user rule that matches a more specific pattern fires first; the synthetic
 * rule only catches paths no user rule matched.
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
  // switch and append a synthetic catch-all rule after user rules, so that
  // under first-match-wins any more specific user rule fires first. If the
  // user already has an *unscoped* `/*` → `/index.html`, skip the append so
  // we don't ship two identical rules (which would trip the duplicate-source
  // lint). A host-scoped catch-all only covers one hostname, so other bound
  // hosts still need the synthetic global SPA fallback.
  const alreadyHasCatchAll = userRules.some(
    (r) => r.host === undefined && r.source === '/*' && r.destination === '/index.html',
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
    fallbackRules: [...userRules, syntheticSpaFallback],
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
 * Map of common asset file extensions → content type. Mirrors
 * `packages/dispatch/src/static.ts`'s MIME_TYPES table so the value the CLI
 * declares for the R2 PUT signature matches what dispatch will serve later
 * (dispatch reads `obj.httpMetadata?.contentType` first, falling back to
 * path-based inference). Keeping the tables aligned avoids a needless
 * mismatch where R2-stored content-type and serve-time content-type
 * disagree on the same asset.
 */
const ASSET_MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  toml: 'application/toml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

/**
 * Resolve the content-type to declare on a direct-to-R2 PUT for `path`.
 * The value is part of the signed Content-Type header on the presigned
 * URL — if the bytes are uploaded with a different content-type, R2
 * rejects the PUT (signature mismatch). Defaults to
 * `application/octet-stream` for unknown extensions.
 */
export function getAssetContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ASSET_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Compute MD5 of raw content as a 32-char lowercase hex string.
 *
 * Used as the wire-level upload-integrity primitive on direct-to-R2 PUTs:
 * R2's S3 compatibility layer enforces `Content-MD5` (RFC 1864) on PutObject,
 * so the upload itself fails if uploaded bytes don't match the declared MD5.
 * MD5 collision resistance is acceptable here because (a) this hash is purely
 * an upload-integrity primitive (BLAKE3 remains the canonical content key),
 * and (b) project-scoped storage (`assets/${projectId}/${blake3}`) means any
 * collision attack is exploitable only against the attacker's own project.
 */
export function computeMd5(content: Buffer): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Compute both BLAKE3 (CF-compatible asset hash) and MD5 (wire-level R2
 * upload-integrity checksum) from a single in-memory buffer. Returned in
 * the v2 manifest entry shape for direct-to-R2 deploys.
 *
 * Single-pass: callers read the file once into `content`; this function
 * then derives both digests from that buffer. The file is never read twice.
 */
export function computeAssetHashes(
  content: Buffer,
  filePath: string,
): { blake3: string; md5: string } {
  return {
    blake3: computeAssetHash(content, filePath),
    md5: computeMd5(content),
  };
}

/**
 * Create a filter function that excludes .assetsignore, _headers, _redirects,
 * OS metadata files, dotenv files, deploy-internal patterns, and any patterns
 * listed in a .assetsignore file.
 * Matches Wrangler's createAssetsIgnoreFunction from workers-shared/utils/helpers.ts.
 */
function createAssetsIgnoreFunction(
  dir: string,
  extraPatterns: Array<string> = [],
): {
  isIgnored: (relativePath: string) => boolean;
  assetsIgnoreFilePresent: boolean;
} {
  const patterns = [
    '/.assetsignore',
    '/_redirects',
    '/_headers',
    '.DS_Store',
    '.env',
    '.env.*',
    ...extraPatterns,
  ];
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

/**
 * Asset manifest entry — v2 shape. Carries both hashes:
 *   - `blake3`: 32 hex chars; the canonical content-addressed storage key
 *     (`assets/${projectId}/${blake3}`). Compatible with Cloudflare's
 *     Workers Static Assets upload API.
 *   - `md5`: 32 hex chars; the wire-level upload-integrity primitive used
 *     by R2's `Content-MD5` (RFC 1864) enforcement on direct PUTs.
 *
 * The `hash` field is a deprecated v1 alias kept equal to `blake3` so
 * existing CLI/test code that reads `entry.hash` keeps working for one
 * release. Remove in a follow-up PR after consumers migrate to `blake3`.
 */
export type AssetManifestEntry = {
  blake3: string;
  md5: string;
  size: number;
  /** @deprecated v1 alias of `blake3`; remove in next release. */
  hash: string;
};

/**
 * Collect all files in a directory, compute hashes, and return both the
 * manifest (for preflight) and the raw file map (for selective packaging).
 *
 * Each file is read from disk exactly once. Both BLAKE3 (storage key) and
 * MD5 (R2 upload-integrity) digests are derived from that single buffer.
 */
export async function collectAndHashAssets(
  dir: string,
  onProgress?: ProgressCallback,
  opts: { ignorePatterns?: Array<string> } = {},
): Promise<{
  assetManifest: Record<string, AssetManifestEntry>;
  assetFiles: Map<string, Buffer>;
}> {
  const assetManifest: Record<string, AssetManifestEntry> = {};
  const assetFiles = new Map<string, Buffer>();

  try {
    const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(
      dir,
      opts.ignorePatterns,
    );
    const files = collectAssetFiles(dir, isIgnored);
    let processed = 0;
    for (const filePath of files) {
      processed++;
      await tickProgress(processed, files.length, onProgress, 'Hashing assets');
      const relativePath = '/' + toSlash(relative(dir, filePath));
      if (isIgnored(relativePath)) {
        continue;
      }
      checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
      // Single disk read per file; both hashes are derived from the same buffer.
      const content = readFileSync(filePath);
      const { blake3, md5 } = computeAssetHashes(content, filePath);
      assetManifest[relativePath] = {
        blake3,
        md5,
        size: content.length,
        // Deprecated v1 alias — kept equal to blake3 for one release so any
        // consumer still reading `entry.hash` keeps working. Remove in a
        // follow-up PR.
        hash: blake3,
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

/** Optional overrides for binding names and worker metadata. */
export type PackageOptions = {
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
  /** Resolved void/live Durable Object binding and class names. */
  live?: LiveBindingConfig;
  /** Query params that participate in ISR variant keys for dispatch rewrites. */
  revalidateQueryAllowlist?: Record<string, Array<string>>;
};

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

function toLiveManifest(live?: LiveBindingConfig): import('./types.ts').LiveManifestMeta {
  const bindingName = live?.bindingName ?? DEFAULT_LIVE_BINDING;
  const className = live?.className ?? DEFAULT_LIVE_CLASS;
  return {
    bindingName,
    className,
    storage: 'sqlite',
    classes: [className],
    migrations: [{ tag: LIVE_MIGRATION_TAG, newSqliteClasses: [className] }],
  };
}

/**
 * If the user configured `routing.fallbacks` on a non-SPA app, the platform
 * still applies the rules but no `/* -> /index.html` SPA shell is synthesised
 * — unmatched paths fall through to the platform 404. Returns the warning
 * message string when that mismatch is detected, or `null` otherwise. Pure
 * function; callers decide whether/how to surface the message (CLI progress,
 * `console.warn`, etc.).
 */
export function detectNonSpaFallbackWarning(
  assetConfig: AssetConfig | undefined,
  fallbackRules: Array<DevRedirectRule> | undefined,
): string | null {
  if (assetConfig?.not_found_handling === 'single-page-application') {
    return null;
  }
  if (!fallbackRules || fallbackRules.length === 0) {
    return null;
  }
  return (
    `routing.fallbacks is set but appType is not "spa"; fallbacks will be applied, ` +
    `but no "/* -> /index.html" SPA shell fallback is synthesised — unmatched paths fall through to the platform 404.`
  );
}

/**
 * Build a Void-app deploy manifest from the inferred bindings + per-feature
 * inputs. Pure shape transformation: reads no files, has no I/O.
 *
 * Note: callers are responsible for surfacing the non-SPA-fallbacks warning
 * (see `detectNonSpaFallbackWarning`) before invoking this builder. The
 * builder itself stays I/O-free.
 */
export function buildVoidManifest(opts: {
  bindings: InferredBindings;
  migrations?: Array<MigrationFile>;
  schedules?: Array<ScheduleMeta>;
  ssr?: boolean;
  framework?: string;
  revalidate?: number | Record<string, number>;
  pages?: Array<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  vars?: Record<string, string>;
  queues?: Array<QueueMeta>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  options?: PackageOptions;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  dialect?: 'sqlite' | 'postgresql';
  webSockets?: Array<WebSocketRouteDefinition>;
}): DeployManifest {
  const {
    bindings,
    migrations,
    schedules,
    ssr,
    framework,
    revalidate,
    pages,
    pathRevalidate,
    vars,
    queues,
    prerender,
    assetConfig,
    options,
    hashedAssetsPrefix,
    headerRules,
    redirectRules,
    fallbackRules,
    dialect,
    webSockets,
  } = opts;

  const manifest: DeployManifest = { version: 3, assetManifestVersion: 2, bindings: {} };
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
  if (bindings.needsLive) {
    manifest.live = toLiveManifest(options?.live);
  }

  if (migrations && migrations.length > 0) {
    const planBundle = dialect === 'postgresql' ? undefined : buildMigrationPlanBundle(migrations);
    manifest.migrations = {
      dialect: dialect ?? 'sqlite',
      ...(planBundle
        ? {
            classifierVersion: planBundle.classifierVersion,
            migrationListHash: planBundle.migrationListHash,
            protocolVersion: planBundle.protocolVersion,
            stability: planBundle.plans.some((plan) => plan.stability === 'legacy')
              ? 'legacy'
              : 'stable',
          }
        : {}),
      pending: migrations.length,
    };
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

  if (pages && pages.length > 0) {
    manifest.pages = pages;
  }

  if (pathRevalidate && Object.keys(pathRevalidate).length > 0) {
    manifest.pathRevalidate = pathRevalidate;
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
  //
  // The non-SPA-fallbacks mismatch warning that used to live here moved to
  // the callers (see `detectNonSpaFallbackWarning`); this function stays
  // I/O-free per its documented contract.
  let resolvedAssetConfig = assetConfig;
  let resolvedFallbackRules = fallbackRules;
  if (assetConfig?.not_found_handling === 'single-page-application') {
    const chain = resolveSpaFallbackChain('spa', fallbackRules);
    resolvedAssetConfig = { ...assetConfig, ...chain.assetConfig };
    resolvedFallbackRules = chain.fallbackRules;
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

  return manifest;
}

/**
 * Read every worker module under `workerDir` once and return them as a map
 * keyed by relative path. Skipped files (build metadata, wrangler config,
 * non-module extensions) are filtered out by `isWorkerModule`. Reads each
 * file from disk exactly once — buffer threading downstream is the caller's
 * responsibility.
 */
export function collectWorkerFiles(workerDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let workerPaths: Array<string>;
  try {
    workerPaths = collectFiles(workerDir);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return out;
    }
    throw err;
  }
  for (const filePath of workerPaths) {
    const relativePath = toSlash(relative(workerDir, filePath));
    if (!isWorkerModule(relativePath)) {
      continue;
    }
    out.set(relativePath, readFileSync(filePath));
  }
  return out;
}

/**
 * Build a static-deploy manifest. Pure shape transformation — no I/O.
 */
export function buildStaticManifest(opts: {
  appType: 'spa' | 'static';
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
}): DeployManifest {
  const { appType, hashedAssetsPrefix, headerRules, redirectRules, fallbackRules } = opts;
  const { assetConfig, fallbackRules: resolvedFallbackRules } = resolveSpaFallbackChain(
    appType,
    fallbackRules,
  );

  const manifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
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

  return manifest;
}

/**
 * Build a framework-deploy manifest. Pure shape transformation — no I/O.
 */
export function buildFrameworkManifest(opts: {
  frameworkName: string;
  workerMain: string;
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
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  dialect?: 'sqlite' | 'postgresql';
  webSockets?: Array<WebSocketRouteDefinition>;
}): DeployManifest {
  const po = opts.packageOptions;

  const manifest: DeployManifest = { version: 3, assetManifestVersion: 2, bindings: {} };
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
  if (opts.bindings.needsLive) {
    throw new Error(FRAMEWORK_LIVE_UNSUPPORTED_MESSAGE);
  }

  if (opts.migrations && opts.migrations.length > 0) {
    const planBundle =
      opts.dialect === 'postgresql' ? undefined : buildMigrationPlanBundle(opts.migrations);
    manifest.migrations = {
      dialect: opts.dialect ?? 'sqlite',
      ...(planBundle
        ? {
            classifierVersion: planBundle.classifierVersion,
            migrationListHash: planBundle.migrationListHash,
            protocolVersion: planBundle.protocolVersion,
            stability: planBundle.plans.some((plan) => plan.stability === 'legacy')
              ? 'legacy'
              : 'stable',
          }
        : {}),
      pending: opts.migrations.length,
    };
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

  return manifest;
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

/**
 * Recursively collect static asset file paths, refusing symlinks so deploys
 * cannot publish bytes from outside the intended asset root.
 */
function collectAssetFiles(
  root: string,
  isIgnored: (relativePath: string) => boolean,
  dir: string = root,
): Array<string> {
  const files: Array<string> = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = '/' + toSlash(relative(root, fullPath));
    if (isIgnored(relativePath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`deploy: Refusing to upload symlink as an asset: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...collectAssetFiles(root, isIgnored, fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
