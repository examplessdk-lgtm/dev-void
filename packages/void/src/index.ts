import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, type Plugin } from "vite";
import { cloudflare, type WorkerConfig } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import { dbTypesPlugin } from "./plugin-db-types";
import {
  inferProjectBindings,
  detectFramework,
  FRAMEWORK_SCAN_DIRS,
  type Framework,
} from "./plugin-inference";
import { scanJobsSync } from "./crons/scan";
import { scanQueuesSync } from "./queues/scan";
import { validateSsrEntry } from "./ssr/entry";
import { readConfig, normalizeAuth, resolveBindingNames } from "./config";
import { ensureWranglerNodejsAlsFlag, syncWranglerBindings } from "./cli/wrangler";
import { getToken, isStagingMode } from "./cli/auth";

export type { AuthProvider } from "./config";

/** Server entry module for each supported framework. */
const FRAMEWORK_ENTRIES: Record<Framework, string> = {
  "tanstack-start": "@tanstack/react-start/server-entry",
  "react-router": "react-router/server-entry",
};

/** Check whether a binding name already exists in a resolved bindings array. */
function hasBinding(list: readonly { binding: string }[] | undefined, name: string): boolean {
  return Array.isArray(list) && list.some((b) => b.binding === name);
}

type CredentialStatus =
  | { status: "ok"; token: string; projectId: string; staging?: boolean }
  | { status: "no-token" }
  | { status: "no-project"; token: string; staging?: boolean };

/**
 * Read Void auth credentials for local dev AI proxy access.
 * Returns a discriminated union so callers can distinguish
 * "no token" from "no project" for targeted onboarding guidance.
 */
function readVoidDevCredentials(root: string): CredentialStatus {
  const token = getToken();
  if (!token) return { status: "no-token" };
  const staging = isStagingMode() || undefined;

  const projectPath = join(root, ".void", "project.json");
  let project: { projectId?: string };
  try {
    project = JSON.parse(readFileSync(projectPath, "utf-8"));
  } catch {
    return { status: "no-project", token, staging };
  }
  if (!project.projectId) {
    return { status: "no-project", token, staging };
  }

  return { status: "ok", token, projectId: project.projectId, staging };
}

const DEFAULT_API_URL = "https://api.void.cloud";
const STAGING_API_URL = "https://api.staging.void.cloud";

/**
 * Interactive AI setup prompt shown during dev server startup when the user
 * has a token but no linked project. Runs as fire-and-forget so it doesn't
 * block the server. On completion, writes project.json and restarts the server.
 */
async function runAiSetupPrompt(
  root: string,
  token: string,
  staging: boolean | undefined,
  server: import("vite").ViteDevServer,
): Promise<void> {
  const { select, text, isCancel, log } = await import("@clack/prompts");
  const { PlatformClient } = await import("./cli/client");
  const { writeProjectConfig } = await import("./cli/project");
  const { inferDefaultSlug } = await import("./cli/resolve-project");

  const apiUrl = staging ? STAGING_API_URL : DEFAULT_API_URL;
  const client = new PlatformClient(token, apiUrl);

  let projects: import("./cli/client").ProjectResponse[];
  try {
    projects = await client.listProjects();
  } catch {
    server.config.logger.warn(
      "[void] Failed to fetch projects. Run `void link` to link a project manually.",
    );
    return;
  }

  const options = [
    { value: "__create__" as const, label: "Create new project" },
    ...projects.map((p: import("./cli/client").ProjectResponse) => ({
      value: p.id,
      label: p.slug,
    })),
  ];

  console.log();
  log.info("[void] AI requires a linked project. Let's set one up:");

  const result = await select({ message: "Select a project:", options });
  if (isCancel(result)) return;

  let projectId: string;
  let slug: string;

  if (result === "__create__") {
    const defaultSlug = inferDefaultSlug(root);
    const slugResult = await text({
      message: "Choose a slug for your new Void project:",
      placeholder: "my-app",
      initialValue: defaultSlug,
      validate(value) {
        const s = (value ?? "").trim();
        if (s.length === 0) return "Project slug is required.";
        const valid =
          s.length === 1 ? /^[a-z0-9]$/.test(s) : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s);
        if (!valid) return "Slug must be lowercase alphanumeric with dashes.";
        return undefined;
      },
    });
    if (isCancel(slugResult)) return;

    try {
      const created = await client.createProject(slugResult.trim());
      projectId = created.id;
      slug = created.slug;
    } catch (err: any) {
      server.config.logger.error(`[void] Failed to create project: ${err.message}`);
      return;
    }
    log.success(`Project created: ${slug}`);
  } else {
    const project = projects.find((p: import("./cli/client").ProjectResponse) => p.id === result)!;
    projectId = project.id;
    slug = project.slug;
  }

  writeProjectConfig(root, { projectId, slug });
  log.success(`Linked to ${slug}`);

  // Restart the dev server so mergeBindings picks up fresh credentials
  await server.restart();
}

/**
 * Void plugin — the main entry point.
 *
 * Composes:
 * 1. Routing plugin (file-based routing from routes/ and middleware/)
 * 2. Migration plugin (auto-apply .sql migrations on dev startup)
 * 3. @cloudflare/vite-plugin (workerd runtime, HMR, builds)
 *
 * Binding inference runs synchronously here so results are available
 * before the Cloudflare plugin initializes.
 *
 * If the user has a `wrangler.json` / `wrangler.toml` in their project root,
 * the Cloudflare plugin reads it and provides the resolved config to our
 * config function. Bindings already defined there (with real IDs for
 * production deployment) are preserved — we only add inferred bindings
 * that are missing. This allows `vite build && wrangler deploy` to work
 * for deploying directly to Cloudflare without the Void platform.
 */
export function voidPlugin(options?: { persistTo?: string }): Plugin[] {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();
  const config = readConfig(root);
  const detected = detectFramework(root);
  const framework = detected?.class === "a" ? (detected.name as Framework) : undefined;

  // Infer bindings synchronously from source files
  const scanDirs = config.scanDirs ?? (detected ? FRAMEWORK_SCAN_DIRS : undefined);
  const inferenceOptions = config.bindings ? { bindings: config.bindings } : undefined;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);

  // Class B/C: lighter composition — DB types + migrations only.
  // The framework's own adapter handles the CF worker build and dev server.
  // voidPlugin() only provides DB type codegen, migration management, and
  // wrangler.jsonc binding sync for local dev.
  if (detected && (detected.class === "b" || detected.class === "c")) {
    const hasAuth = normalizeAuth(config.auth) !== null;
    const bindingNames = resolveBindingNames(config.bindings);
    const frameworkPersistRoot = join(root, ".wrangler", "state");

    // Ensure required compat flags are written before framework adapters
    // initialize Cloudflare dev runtime / Miniflare.
    const wranglerCompatPlugin: Plugin = {
      name: "void:wrangler-compat",
      enforce: "pre",
      config(_, env) {
        if (env.command !== "serve") return;
        const synced = ensureWranglerNodejsAlsFlag(root);
        if (synced) {
          // eslint-disable-next-line no-console
          console.log("[void] Synced nodejs_als to wrangler config");
        }
      },
    };

    // Wrangler.jsonc binding sync plugin — runs on dev startup
    const wranglerSyncPlugin: Plugin = {
      name: "void:wrangler-sync",
      configResolved(resolvedConfig) {
        if (resolvedConfig.command !== "serve") return;
        const synced = syncWranglerBindings(root, bindings, {
          auth: hasAuth,
          bindingNames,
        });
        if (synced) {
          // eslint-disable-next-line no-console
          console.log("[void] Synced bindings to wrangler.jsonc");
        }
      },
    };

    // SvelteKit hooks injection: transform get_hooks() to wrap `handle` with
    // withRuntimeEnv(event.platform.env, ...). This stores the env in
    // AsyncLocalStorage so void/db resolves it via envContext.getStore().
    // Single Miniflare instance (adapter-cloudflare's), no private APIs.
    const svelteKitHooksInjectPlugin: Plugin = {
      name: "void:sveltekit-hooks-inject",
      apply: "serve",
      transform(code, id) {
        if (detected.class !== "b") return;
        if (!id.includes(".svelte-kit/generated/server/internal")) return;
        if (!code.includes("export async function get_hooks")) return;

        return code
          .replace(
            "export async function get_hooks() {",
            `export async function get_hooks() {\n  const { withRuntimeEnv } = await import("void/_env");`,
          )
          .replace(
            /return\s*\{/,
            `const __origHandle = handle ?? (({ event, resolve }) => resolve(event));\n` +
              `  handle = ({ event, resolve }) => withRuntimeEnv(event.platform?.env, () => __origHandle({ event, resolve }));\n` +
              `  return {`,
          );
      },
    };

    return [
      wranglerCompatPlugin,
      wranglerSyncPlugin,
      svelteKitHooksInjectPlugin,
      dbTypesPlugin(root, false),
      migrationPlugin(root, "local", frameworkPersistRoot),
    ];
  }

  // Phase 1: Determine auth providers from imports (sync, at plugin creation)
  // Explicit config takes precedence over auto-detection.
  let authProviders: AuthProvider[] | null;
  if (config.auth !== undefined) {
    authProviders = normalizeAuth(config.auth);
  } else {
    authProviders = bindings.needsAuth ? ["email"] : null;
  }

  // Core worker config — always set by voidPlugin (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};

  // Merge curated wrangler fields from void.json
  if (config.wrangler?.compatibility_date) {
    workerConfig.compatibility_date = config.wrangler.compatibility_date;
  }
  if (config.wrangler?.compatibility_flags) {
    workerConfig.compatibility_flags = config.wrangler.compatibility_flags;
  }
  const inspectorPortEnv = process.env.VOID_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === "false"
      ? false
      : typeof inspectorPortEnv === "string" && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  const inspectorPortOption: { inspectorPort?: number | false } =
    inspectorPort === false
      ? { inspectorPort: false }
      : typeof inspectorPort === "number"
        ? { inspectorPort }
        : {};

  const outDir = join(root, ".void");
  mkdirSync(outDir, { recursive: true });

  // Scan queues early so mergeBindings can reference them in both branches.
  // Framework mode skips queue scanning (empty array).
  const queues = framework ? [] : scanQueuesSync(root);

  // Config function that merges inferred bindings with the resolved config.
  // When the user has a wrangler.json with real binding IDs (for raw CF
  // deployment), those take precedence. We only add placeholder bindings
  // for inferred bindings that are missing from their config.
  // When no wrangler.json exists, resolved config has empty bindings and
  // all inferred bindings are added — matching the previous behavior.
  function mergeBindings(resolved: WorkerConfig): Partial<WorkerConfig> {
    const result: Record<string, unknown> = { ...workerConfig };

    // D1 — auth requires a DB too
    const d1: Record<string, unknown>[] = [];
    if ((bindings.needsD1 || authProviders) && !hasBinding(resolved.d1_databases, "DB")) {
      d1.push({ binding: "DB", database_name: "default", database_id: "local" });
    }
    if (d1.length > 0) {
      result.d1_databases = [...(resolved.d1_databases ?? []), ...d1];
    }

    // KV — auth needs AUTH_KV for sessions
    const kv: { binding: string; id: string }[] = [];
    if (bindings.needsKV && !hasBinding(resolved.kv_namespaces, "KV")) {
      kv.push({ binding: "KV", id: "local" });
    }
    if (authProviders && !hasBinding(resolved.kv_namespaces, "AUTH_KV")) {
      kv.push({ binding: "AUTH_KV", id: "auth-local" });
    }
    if (kv.length > 0) {
      result.kv_namespaces = [...(resolved.kv_namespaces ?? []), ...kv];
    }

    // R2
    if (bindings.needsR2 && !hasBinding(resolved.r2_buckets, "STORAGE")) {
      result.r2_buckets = [
        ...(resolved.r2_buckets ?? []),
        { binding: "STORAGE", bucket_name: "default" },
      ];
    }

    // Queues — add producer + consumer bindings for local dev
    if (queues.length > 0) {
      (result as Record<string, unknown>).queues = {
        producers: queues.map((q) => ({ queue: q.name, binding: q.bindingName })),
        consumers: queues.map((q) => ({
          queue: q.name,
          ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
          ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
        })),
      };
    }

    // AI — in local dev, inject VC credentials for HTTPS proxy path.
    // In production, the platform adds a __AI_PROXY service binding instead.
    if (bindings.needsAI) {
      const credentials = readVoidDevCredentials(root);
      if (credentials.status === "ok") {
        // Prefer HTTPS proxy — inject credentials, skip direct AI binding
        const vars = (result.vars as Record<string, string>) ?? {};
        vars.__VOID_TOKEN = credentials.token;
        vars.__VOID_PROJECT_ID = credentials.projectId;
        if (credentials.staging) vars.__VOID_STAGING = "1";
        result.vars = vars;
      } else if (!resolved.ai) {
        // Fallback: set direct AI binding (requires user's own CF auth)
        result.ai = { binding: "AI" };
      }
    }

    return result as Partial<WorkerConfig>;
  }

  // Plugin that loads .env files and merges them into workerConfig.vars.
  // Runs before the Cloudflare plugin so vars are available as worker bindings.
  // Phase 2: Also auto-detects OAuth providers from env vars.
  const envPlugin: Plugin = {
    name: "void:env",
    config(_, { mode }) {
      // loadEnv with prefix "" returns .env file vars AND all process.env vars.
      // Filter out shell env pollution (MANPATH, PATH, HOME, etc.) by keeping only
      // vars that are new or have a different value than the shell environment.
      const shellKeys = new Set(Object.keys(process.env));
      const loaded = loadEnv(mode, root, "");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(loaded)) {
        if (!shellKeys.has(key) || process.env[key] !== value) {
          env[key] = value;
        }
      }
      workerConfig.vars = { ...(workerConfig.vars as Record<string, string> | undefined), ...env };

      // Auto-detect OAuth providers from env vars (only if not explicitly configured)
      if (config.auth === undefined) {
        if (env.GITHUB_OAUTH_ID) {
          authProviders ??= [];
          if (!authProviders.includes("github")) authProviders.push("github");
        }
        if (env.GOOGLE_OAUTH_ID) {
          authProviders ??= [];
          if (!authProviders.includes("google")) authProviders.push("google");
        }
      }
    },
    configureServer(server) {
      // AI onboarding: detect missing credentials early and guide users
      if (bindings.needsAI) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === "no-token") {
          server.config.logger.warn(
            "[void] AI requires authentication. Run `void login`, then restart the dev server.",
          );
        } else if (credentials.status === "no-project") {
          if (process.stdin.isTTY) {
            // Fire-and-forget interactive setup
            runAiSetupPrompt(root, credentials.token, credentials.staging, server);
          } else {
            server.config.logger.warn(
              "[void] AI requires a linked project. Run `void link` to set one up.",
            );
          }
        }
      }

      if (config.auth !== undefined) return;
      let envHintShown = false;
      const check = (path: string) => {
        if (envHintShown) return;
        if (!path.split("/").pop()?.startsWith(".env")) return;
        try {
          const content = readFileSync(path, "utf-8");
          const providers: string[] = [];
          if (/^GITHUB_OAUTH_ID=/m.test(content) && !authProviders?.includes("github"))
            providers.push("GitHub");
          if (/^GOOGLE_OAUTH_ID=/m.test(content) && !authProviders?.includes("google"))
            providers.push("Google");
          if (providers.length > 0) {
            envHintShown = true;
            server.config.logger.warn(
              `[void] ${providers.join(" and ")} OAuth credentials detected — restart to enable.`,
            );
          }
        } catch {}
      };
      server.watcher.on("change", check);
      server.watcher.on("add", check);
    },
  };

  if (framework) {
    // Framework mode: no routing plugin, CF plugin uses viteEnvironment.
    // The CF plugin needs `main` to create a proper worker environment
    // (without it, the worker is treated as "assets-only" and cloudflare:*
    // modules are not externalized during the SSR build).
    workerConfig.main = FRAMEWORK_ENTRIES[framework];
    // Framework mode requires nodejs_compat — merge with any user-specified flags
    const existingFlags = (workerConfig.compatibility_flags as string[] | undefined) ?? [];
    if (!existingFlags.includes("nodejs_compat")) {
      workerConfig.compatibility_flags = [...existingFlags, "nodejs_compat"];
    }

    return [
      envPlugin,
      dbTypesPlugin(root, false),
      migrationPlugin(root),
      ...cloudflare({
        ...inspectorPortOption,
        persistState: { path: options?.persistTo ?? outDir },
        viteEnvironment: { name: "ssr" },
        config: mergeBindings,
      }),
    ];
  }

  // Default mode: full Hono routing + generated entry
  // Add nodejs_als for AsyncLocalStorage (used by isomorphic fetch context threading)
  const existingFlags = (workerConfig.compatibility_flags as string[] | undefined) ?? [];
  if (!existingFlags.includes("nodejs_als") && !existingFlags.includes("nodejs_compat")) {
    workerConfig.compatibility_flags = [...existingFlags, "nodejs_als"];
  }

  const jobs = scanJobsSync(root);
  const ssrEntry = validateSsrEntry(root);
  const hasPages = existsSync(join(root, "pages"));

  workerConfig.main = join(root, ".void", "entry.ts");

  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: jobs.flatMap((job) => job.crons),
    };
  }

  if (ssrEntry || hasPages) {
    workerConfig.assets = {
      binding: "ASSETS",
      // Route document/API requests to the worker for SSR/Pages. Static assets
      // (hashed files in /assets/) bypass the worker and are served directly
      // from the edge. Dev-only exclusions let Vite serve source modules.
      run_worker_first: [
        "/**",
        "!/assets/*",
        "!/@*",
        "!/src/*",
        "!/node_modules/*",
        ...(hasPages ? ["!/pages/*"] : []),
      ],
    };
  }

  return [
    envPlugin,
    routingPlugin(root, { getAuth: () => authProviders, autoDetect: config.auth === undefined }),
    dbTypesPlugin(root, true),
    migrationPlugin(root),
    ...cloudflare({
      ...inspectorPortOption,
      persistState: { path: options?.persistTo ?? outDir },
      config: mergeBindings,
    }),
  ];
}

// Re-export runtime types and functions
export {
  defineHandler,
  defineMiddleware,
  defineScheduled,
  defineRender,
  defineQueue,
} from "./runtime/handler";
export type {
  CloudContext,
  CloudContextVariables,
  CloudEnv,
  RenderAssetTags,
  TypedHandler,
  TypedQueueHandler,
  QueueBatch,
  QueueMessage,
} from "./runtime/handler";
export type { ValidatorSlots, HandlerInput } from "./runtime/validator";
export type { AuthUser } from "./runtime/auth";
export type { QueueMap } from "./runtime/queues";
export { defer } from "./pages/defer";
export type { Deferred, InferProps } from "./pages/defer";

type AuthProvider = import("./config").AuthProvider;
