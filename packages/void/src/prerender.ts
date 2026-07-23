import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'pathslash';
import { loadEnv } from 'vite';
import { getToken, isStagingMode } from './cli/auth.ts';
import { ensureWranglerCompat } from './cli/wrangler.ts';
import { readConfig } from './config.ts';
import { voidLog, voidWarn } from './log.ts';
import { filterLoadedEnv, stripInternalEnvKeys } from './shared/env.ts';
import { DEFAULT_PROXY_URL, STAGING_PROXY_URL } from './shared/proxy.ts';

const PRERENDER_PATHS_ENDPOINT = '/__void/prerender-paths';
const STATIC_PAGE_DATA_DIR = '_void/pages';

type PrerenderWorkerModuleType = 'ESModule' | 'CommonJS' | 'CompiledWasm' | 'Text' | 'Data';

export type PrerenderWorkerModule = {
  path: string;
  type: PrerenderWorkerModuleType;
  contents: string | Uint8Array;
};

export type PrerenderResult = {
  rendered: Array<string>;
  failed: Array<{ path: string; error: string }>;
};

export type PrerenderRunResult = PrerenderResult & {
  paths: Array<string>;
};

function outputFileForPath(path: string): string {
  return path === '/' ? 'index.html' : `${path.slice(1)}.html`;
}

function pageDataFileForPath(path: string): string {
  return path === '/'
    ? `${STATIC_PAGE_DATA_DIR}/index.json`
    : `${STATIC_PAGE_DATA_DIR}/${path.slice(1)}.json`;
}

async function readPrerenderPathsResponse(response: Response): Promise<Array<string>> {
  if (!response.ok) {
    throw new Error(`prerender: Failed to collect prerender paths. HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as { paths?: unknown };
  if (!Array.isArray(payload.paths) || !payload.paths.every((path) => typeof path === 'string')) {
    throw new Error('prerender: Failed to collect prerender paths. Response payload is invalid.');
  }

  return payload.paths;
}

async function renderPrerenderPaths(
  paths: Array<string>,
  clientDir: string,
  fetchPath: (path: string) => Promise<Response>,
  fetchPageData?: (path: string) => Promise<Response>,
): Promise<PrerenderResult> {
  const result: PrerenderResult = { rendered: [], failed: [] };

  for (const path of paths) {
    try {
      const response = await fetchPath(path);
      const html = await response.text();

      if (!response.ok) {
        result.failed.push({ path, error: `HTTP ${response.status}` });
        voidWarn(`prerender ${path} failed: HTTP ${response.status}`);
        continue;
      }

      const outputFile = outputFileForPath(path);
      const outputPath = join(clientDir, outputFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, html);

      if (fetchPageData) {
        const pageDataResponse = await fetchPageData(path);
        if (pageDataResponse.headers.get('X-VoidPages')) {
          const pageData = await pageDataResponse.json();
          const pageDataFile = pageDataFileForPath(path);
          const pageDataPath = join(clientDir, pageDataFile);
          mkdirSync(dirname(pageDataPath), { recursive: true });
          writeFileSync(pageDataPath, JSON.stringify(pageData));
        }
      }

      result.rendered.push(path);
      voidLog(`prerender \x1b[36m${outputFile}\x1b[39m`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ path, error });
      voidWarn(`prerender ${path} failed: ${error}`);
    }
  }

  return result;
}

function normalizeWorkerModulePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveWorkerModuleType(relativePath: string): PrerenderWorkerModuleType | null {
  const normalized = normalizeWorkerModulePath(relativePath);

  if (normalized.includes('/.vite/') || normalized.startsWith('.vite/')) {
    return null;
  }
  if (normalized === 'wrangler.json' || normalized === 'wrangler.jsonc') {
    return null;
  }
  if (normalized.endsWith('.mjs') || normalized.endsWith('.js')) {
    return 'ESModule';
  }
  if (normalized.endsWith('.cjs')) {
    return 'CommonJS';
  }
  if (normalized.endsWith('.wasm')) {
    return 'CompiledWasm';
  }
  if (normalized.endsWith('.txt')) {
    return 'Text';
  }
  if (normalized.endsWith('.bin')) {
    return 'Data';
  }

  return null;
}

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

export function collectPrerenderWorkerModules(
  workerDir: string,
  workerMain: string,
): Array<PrerenderWorkerModule> {
  const normalizedEntry = normalizeWorkerModulePath(workerMain);
  type CollectedPrerenderWorkerModule = PrerenderWorkerModule & {
    relativePath: string;
  };

  const modules: Array<CollectedPrerenderWorkerModule> = collectFiles(workerDir).flatMap(
    (filePath) => {
      const relativePath = normalizeWorkerModulePath(relative(workerDir, filePath));
      const type = resolveWorkerModuleType(relativePath);
      if (!type) {
        return [];
      }

      const file = readFileSync(filePath);
      const contents: PrerenderWorkerModule['contents'] =
        type === 'CompiledWasm' || type === 'Data' ? new Uint8Array(file) : file.toString('utf-8');

      return [{ path: filePath, relativePath, type, contents }];
    },
  );

  modules.sort((a, b) => {
    if (a.relativePath === normalizedEntry) {
      return -1;
    }
    if (b.relativePath === normalizedEntry) {
      return 1;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  if (!modules.some((module) => module.relativePath === normalizedEntry)) {
    throw new Error(`prerender: Worker entry '${normalizedEntry}' not found in '${workerDir}'.`);
  }

  return modules.map(({ relativePath: _relativePath, ...module }) => module);
}

export type PrerenderBindingsInput = {
  wranglerVars: Record<string, unknown> | undefined;
  env: Record<string, string>;
  voidToken: string | null | undefined;
  voidProjectId: string | undefined;
  voidStaging: boolean;
  remoteMode: boolean | undefined;
};

export function buildPrerenderBindings(input: PrerenderBindingsInput): Record<string, unknown> {
  const { sanitized: wranglerVars, stripped: wranglerStripped } = stripInternalEnvKeys(
    input.wranglerVars,
  );
  const { sanitized: env, stripped: envStripped } = stripInternalEnvKeys(input.env);
  const allStripped = [...new Set([...wranglerStripped, ...envStripped])];
  if (allStripped.length > 0) {
    voidWarn(
      `Ignoring internal env keys in prerender inputs: ${allStripped.join(', ')}. These are reserved for Void runtime use.`,
    );
  }

  const voidBindings: Record<string, string> = {};
  if (input.voidToken && input.voidProjectId) {
    voidBindings.__VOID_TOKEN = input.voidToken;
    voidBindings.__VOID_PROJECT_ID = input.voidProjectId;
    if (input.voidStaging) {
      voidBindings.__VOID_STAGING = '1';
    }
    voidBindings.__VOID_PROXY_URL = input.voidStaging ? STAGING_PROXY_URL : DEFAULT_PROXY_URL;
    if (input.remoteMode) {
      voidBindings.__VOID_REMOTE = '1';
    }
  }
  return { ...wranglerVars, ...env, ...voidBindings };
}

async function createCloudflarePrerenderRunner(options: {
  root: string;
  workerDir: string;
  persistDir: string;
  clientDir?: string;
  remoteMode?: boolean;
  projectId?: string;
}) {
  const { root, workerDir, persistDir, clientDir, remoteMode } = options;

  const wranglerPath = join(workerDir, 'wrangler.json');
  if (!existsSync(wranglerPath)) {
    throw new Error(`prerender: wrangler.json not found in '${workerDir}'.`);
  }
  const wranglerConfig = JSON.parse(readFileSync(wranglerPath, 'utf-8'));
  const wranglerCompat = ensureWranglerCompat(root, readConfig(root), workerDir);
  const workerMain = wranglerConfig.main ?? 'index.js';

  const env = filterLoadedEnv(loadEnv('production', root, ''));

  // Resolve Void projectId via a three-level chain:
  //   1. explicit options.projectId — passed from runFullDeploy so the
  //      `void deploy --project <slug>` flow works even when the in-memory
  //      config hasn't been persisted to .void/project.json yet.
  //   2. VOID_DEPLOY_PROJECT_ID env var — crosses the process boundary for
  //      the static-output path, where plugin-prerender's closeBundle runs
  //      inside the vite build subprocess and can't see the parent's config.
  //   3. .void/project.json — existing on-disk fallback for linked projects.
  const voidToken = getToken(root);
  let voidProjectId: string | undefined = options.projectId;
  if (!voidProjectId) {
    voidProjectId = process.env.VOID_DEPLOY_PROJECT_ID || undefined;
  }
  if (!voidProjectId) {
    const projectJsonPath = join(root, '.void', 'project.json');
    try {
      voidProjectId = JSON.parse(readFileSync(projectJsonPath, 'utf-8')).projectId;
    } catch {
      // No linked project — prerender without Void credentials.
    }
  }
  const voidStaging = isStagingMode(root);

  const bindings = buildPrerenderBindings({
    wranglerVars: wranglerConfig.vars,
    env,
    voidToken,
    voidProjectId,
    voidStaging,
    remoteMode,
  });

  const wranglerUrl = import.meta.resolve('wrangler/package.json');
  const require = createRequire(wranglerUrl);
  const miniflarePath = require.resolve('miniflare');
  const { Miniflare } = (await import(pathToFileURL(miniflarePath).href)) as {
    Miniflare: new (options: Record<string, unknown>) => {
      dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      dispose(): Promise<void>;
    };
  };

  const mfOptions: Record<string, unknown> = {
    modules: collectPrerenderWorkerModules(workerDir, workerMain),
    modulesRoot: workerDir,
    compatibilityDate: wranglerCompat.compatibilityDate,
    compatibilityFlags: wranglerCompat.compatibilityFlags ?? [],
    bindings,
  };

  if (clientDir) {
    mfOptions.serviceBindings = {
      [wranglerConfig.assets?.binding ?? 'ASSETS'](request: Request) {
        const url = new URL(request.url);
        const filePath = join(clientDir, url.pathname);
        try {
          const content = readFileSync(filePath);
          return new Response(content);
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      },
    };
  }

  const d1 = wranglerConfig.d1_databases;
  if (Array.isArray(d1) && d1.length > 0) {
    const databases: Record<string, string> = {};
    for (const db of d1) {
      databases[db.binding] = db.database_id;
    }
    mfOptions.d1Databases = databases;
    mfOptions.d1Persist = persistDir;
  }

  const kv = wranglerConfig.kv_namespaces;
  if (Array.isArray(kv) && kv.length > 0) {
    const namespaces: Record<string, string> = {};
    for (const ns of kv) {
      namespaces[ns.binding] = ns.id;
    }
    mfOptions.kvNamespaces = namespaces;
    mfOptions.kvPersist = persistDir;
  }

  const r2 = wranglerConfig.r2_buckets;
  if (Array.isArray(r2) && r2.length > 0) {
    const buckets: Record<string, string> = {};
    for (const bucket of r2) {
      buckets[bucket.binding] = bucket.bucket_name;
    }
    mfOptions.r2Buckets = buckets;
    mfOptions.r2Persist = persistDir;
  }

  const mf = new Miniflare(mfOptions);
  const allBindings = mfOptions.bindings as Record<string, unknown> | undefined;
  const proxyToken = allBindings?.__VOID_PROXY_TOKEN as string | undefined;

  return {
    async collectPaths(): Promise<Array<string>> {
      const headers: Record<string, string> = {};
      if (proxyToken) {
        headers['x-void-internal'] = proxyToken;
      }
      return readPrerenderPathsResponse(
        await mf.dispatchFetch(`http://localhost${PRERENDER_PATHS_ENDPOINT}`, {
          method: 'POST',
          headers,
        }),
      );
    },
    async fetchPath(path: string): Promise<Response> {
      return mf.dispatchFetch(`http://localhost${path}`);
    },
    async fetchPageData(path: string): Promise<Response> {
      return mf.dispatchFetch(`http://localhost${path}`, {
        headers: { Accept: 'application/json', Purpose: 'prefetch', 'X-VoidPages': 'true' },
      });
    },
    async close() {
      await mf.dispose();
    },
  };
}

export async function collectPrerenderPaths(options: {
  root: string;
  workerDir: string;
  persistDir: string;
  clientDir?: string;
  remoteMode?: boolean;
  projectId?: string;
}): Promise<Array<string>> {
  const runner = await createCloudflarePrerenderRunner(options);
  try {
    return await runner.collectPaths();
  } finally {
    await runner.close();
  }
}

/**
 * Prerender pages by spinning up Miniflare with the built worker.
 * Collects paths through the built worker's internal endpoint and then
 * fetches each page, writing HTML responses to `clientDir`.
 */
export async function prerenderPages(options: {
  root: string;
  workerDir: string;
  clientDir: string;
  persistDir: string;
  remoteMode?: boolean;
  projectId?: string;
}): Promise<PrerenderRunResult> {
  const runner = await createCloudflarePrerenderRunner(options);
  try {
    const paths = await runner.collectPaths();
    if (paths.length === 0) {
      return { paths, rendered: [], failed: [] };
    }

    const result = await renderPrerenderPaths(
      paths,
      options.clientDir,
      (path) => runner.fetchPath(path),
      (path) => runner.fetchPageData(path),
    );
    return { paths, ...result };
  } finally {
    await runner.close();
  }
}

type NodeRunnerConfig =
  | { mode: 'collect'; ssrDir: string; clientDir?: string }
  | { mode: 'collect-and-render'; ssrDir: string; clientDir: string };

async function runNodePrerenderRunner<T>(root: string, config: NodeRunnerConfig): Promise<T> {
  // Mirror the sanitization pipeline used by envPlugin.config (index.ts),
  // buildPrerenderBindings (CF runner), and loadDeployEnv (deploy.ts): strip
  // any internal Void keys a user may have placed in .env.production so they
  // can't shadow or pollute the child process env via the `...env` spread
  // below. Consistency matters — all sites that ingest user .env files must
  // run the same sanitizer, or drift will reintroduce the leak.
  const filtered = filterLoadedEnv(loadEnv('production', root, ''));
  const { sanitized: env, stripped } = stripInternalEnvKeys(filtered);
  if (stripped.length > 0) {
    voidWarn(
      `Ignoring internal env keys from .env files in Node prerender runner: ${stripped.join(', ')}. These are reserved for Void runtime use.`,
    );
  }
  const runnerPath = join(root, '.void', 'prerender-runner.mjs');
  mkdirSync(dirname(runnerPath), { recursive: true });
  writeFileSync(
    runnerPath,
    `
import { pathToFileURL } from "node:url";
import { join, dirname } from "pathslash";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { mode, ssrDir, clientDir } = config;

if (clientDir) {
  try {
    const manifestPath = join(clientDir, ".vite", "manifest.json");
    globalThis.__VITE_MANIFEST__ = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    // Ignore missing manifests so prerender can continue without client assets.
  }
}

const appUrl = pathToFileURL(join(ssrDir, "app.js")).href;
const app = await import(appUrl);
const fetch = app.default?.fetch;
if (!fetch) {
  console.error("[void] No default export with fetch() found in app.js");
  process.exit(1);
}

async function collectPaths() {
  const headers = {};
  if (process.env.__VOID_PROXY_TOKEN) headers["x-void-internal"] = process.env.__VOID_PROXY_TOKEN;
  const response = await fetch(
    new Request("http://localhost${PRERENDER_PATHS_ENDPOINT}", { method: "POST", headers }),
  );
  if (!response.ok) {
    throw new Error("prerender: Failed to collect prerender paths. HTTP " + response.status + ".");
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.paths) || !payload.paths.every((path) => typeof path === "string")) {
    throw new Error("prerender: Failed to collect prerender paths. Response payload is invalid.");
  }
  return payload.paths;
}

async function renderPaths(paths) {
  if (!clientDir) return { rendered: [], failed: [] };
  const result = { rendered: [], failed: [] };

  for (const path of paths) {
    try {
      const response = await fetch(new Request("http://localhost" + path));
      const html = await response.text();
      if (!response.ok) {
        result.failed.push({ path, error: "HTTP " + response.status });
        continue;
      }
      const outputFile = path === "/" ? "index.html" : path.slice(1) + ".html";
      const outputPath = join(clientDir, outputFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, html);
      const pageDataResponse = await fetch(new Request("http://localhost" + path, {
        headers: { "Accept": "application/json", "Purpose": "prefetch", "X-VoidPages": "true" },
      }));
      if (pageDataResponse.headers.get("X-VoidPages")) {
        const pageData = await pageDataResponse.json();
        const pageDataFile = path === "/" ? "_void/pages/index.json" : "_void/pages/" + path.slice(1) + ".json";
        const pageDataPath = join(clientDir, pageDataFile);
        mkdirSync(dirname(pageDataPath), { recursive: true });
        writeFileSync(pageDataPath, JSON.stringify(pageData));
      }
      result.rendered.push(path);
    } catch (err) {
      result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

if (mode === "collect") {
  process.stdout.write(JSON.stringify({ paths: await collectPaths() }));
} else {
  const paths = await collectPaths();
  const result = await renderPaths(paths);
  process.stdout.write(JSON.stringify({ paths, ...result }));
}
`,
  );

  try {
    return await new Promise<T>((resolve, reject) => {
      execFile(
        process.execPath,
        [runnerPath, JSON.stringify(config)],
        { env: { ...process.env, ...env }, cwd: root, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (stderr) {
            process.stderr.write(stderr);
          }
          if (error) {
            reject(new Error(`Prerender child process failed: ${error.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(`Failed to parse prerender output: ${stdout}`));
          }
        },
      );
    });
  } finally {
    try {
      unlinkSync(runnerPath);
    } catch {
      // Ignore cleanup failures for the temporary prerender runner.
    }
  }
}

export async function collectPrerenderPathsNode(options: {
  root: string;
  ssrDir: string;
  clientDir?: string;
}): Promise<Array<string>> {
  const result = await runNodePrerenderRunner<{ paths: Array<string> }>(options.root, {
    mode: 'collect',
    ssrDir: options.ssrDir,
    clientDir: options.clientDir,
  });
  return result.paths;
}

/**
 * Prerender pages for Node.js targets by spawning a child process.
 *
 * Uses a child process to avoid mutating `process.env` in the parent Vite
 * build process. The child imports the built app, collects prerender paths
 * from the internal endpoint, renders each page, and returns the result.
 */
export async function prerenderPagesNode(options: {
  root: string;
  ssrDir: string;
  clientDir: string;
}): Promise<PrerenderRunResult> {
  const result = await runNodePrerenderRunner<PrerenderRunResult>(options.root, {
    mode: 'collect-and-render',
    ssrDir: options.ssrDir,
    clientDir: options.clientDir,
  });

  for (const path of result.rendered) {
    voidLog(`prerender \x1b[36m${outputFileForPath(path)}\x1b[39m`);
  }
  for (const { path, error } of result.failed) {
    voidWarn(`prerender ${path} failed: ${error}`);
  }

  return result;
}
