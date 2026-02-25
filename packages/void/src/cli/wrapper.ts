import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import type { AuthProvider } from "../config";

export interface WrapperFeatures {
  /** Absolute path to the framework's original worker entry. */
  originalEntry: string;
  /** Auth providers to enable, or null if no auth. */
  auth: AuthProvider[] | null;
  /** Cron job definitions (from scanJobsSync). */
  crons: { name: string; filePath: string; crons: string[] }[];
  /** Queue consumer definitions (from scanQueuesSync). */
  queues: { name: string; filePath: string; bindingName: string }[];
}

export interface WrapperResult {
  /** Filename of the bundled wrapper entry module. */
  entryFilename: string;
  /** Absolute path to the directory containing the bundled wrapper. */
  outputDir: string;
}

/**
 * Determine whether a wrapper is needed based on the features.
 */
export function needsWrapper(features: WrapperFeatures): boolean {
  return features.auth !== null || features.crons.length > 0 || features.queues.length > 0;
}

/**
 * Generate a wrapper module, bundle it with Vite, and return the output info.
 *
 * The wrapper wraps the framework's original worker with:
 * - Auth session middleware + routes (if auth is enabled)
 * - Scheduled handler for cron jobs (if any)
 * - Queue handler for queue consumers (if any)
 */
export async function generateAndBundleWrapper(
  root: string,
  features: WrapperFeatures,
): Promise<WrapperResult> {
  const tmpDir = join(root, ".void", "wrapper");
  mkdirSync(tmpDir, { recursive: true });

  // Generate wrapper source
  const entrySource = generateWrapperSource(root, tmpDir, features);
  const entryPath = join(tmpDir, "entry.ts");
  writeFileSync(entryPath, entrySource);

  // Generate scheduled handler if needed
  if (features.crons.length > 0) {
    writeFileSync(join(tmpDir, "scheduled.ts"), generateScheduledSource(root, features.crons));
  }

  // Generate queue handler if needed
  if (features.queues.length > 0) {
    writeFileSync(join(tmpDir, "queue.ts"), generateQueueSource(root, features.queues));
  }

  // Generate auth handler if needed
  if (features.auth) {
    writeFileSync(join(tmpDir, "auth.ts"), generateAuthSource(features.auth));
  }

  // Bundle with Vite
  const outDir = join(tmpDir, "out");
  await build({
    root: tmpDir,
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry: entryPath,
        formats: ["es"],
        fileName: "wrapper",
      },
      rollupOptions: {
        external: ["node:async_hooks", "cloudflare:workers"],
      },
      minify: false,
      target: "esnext",
    },
    resolve: {
      alias: {
        __ORIGINAL_WORKER__: features.originalEntry,
        __VOID_AUTH__: fileURLToPath(import.meta.resolve("void/auth")),
      },
    },
  });

  return {
    entryFilename: "wrapper.mjs",
    outputDir: outDir,
  };
}

/**
 * Clean up generated wrapper files.
 */
export function cleanupWrapper(root: string): void {
  rmSync(join(root, ".void", "wrapper"), { recursive: true, force: true });
}

// ─── Source Generators ─────────────────────────────────────────────

function generateWrapperSource(root: string, tmpDir: string, features: WrapperFeatures): string {
  const lines: string[] = [];

  lines.push(`import original from "__ORIGINAL_WORKER__";`);

  if (features.auth) {
    lines.push(`import { handleAuth, resolveSession, authContext } from "./auth.ts";`);
  }
  if (features.crons.length > 0) {
    lines.push(`import { handleScheduled } from "./scheduled.ts";`);
  }
  if (features.queues.length > 0) {
    lines.push(`import { handleQueue } from "./queue.ts";`);
  }

  lines.push("");
  lines.push("export default {");

  // fetch handler
  if (features.auth) {
    lines.push("  async fetch(request, env, ctx) {");
    lines.push("    const url = new URL(request.url);");
    lines.push(`    if (url.pathname.startsWith("/auth/")) {`);
    lines.push("      return handleAuth(request, env, ctx, url);");
    lines.push("    }");
    lines.push("    const user = await resolveSession(request, env);");
    lines.push("    return authContext.run({ user }, () => original.fetch(request, env, ctx));");
    lines.push("  },");
  } else {
    lines.push("  fetch: original.fetch,");
  }

  // scheduled handler
  if (features.crons.length > 0) {
    lines.push("  scheduled: handleScheduled,");
  }

  // queue handler
  if (features.queues.length > 0) {
    lines.push("  queue: handleQueue,");
  }

  lines.push("};");

  return lines.join("\n");
}

function generateScheduledSource(root: string, crons: WrapperFeatures["crons"]): string {
  const lines: string[] = [];

  // Import cron handler files
  for (let i = 0; i < crons.length; i++) {
    const absPath = join(root, "crons", crons[i].filePath);
    lines.push(`import handler${i} from "${absPath}";`);
  }

  lines.push("");
  lines.push("export async function handleScheduled(controller, env, ctx) {");
  lines.push("  switch (controller.cron) {");

  for (let i = 0; i < crons.length; i++) {
    for (const expr of crons[i].crons) {
      lines.push(`    case ${JSON.stringify(expr)}:`);
    }
    lines.push(`      if (typeof handler${i} === "function") {`);
    lines.push(`        await handler${i}(controller, env, ctx);`);
    lines.push(`      } else if (handler${i} && typeof handler${i}.default === "function") {`);
    lines.push(`        await handler${i}.default(controller, env, ctx);`);
    lines.push(`      }`);
    lines.push(`      return;`);
  }

  lines.push("  }");
  lines.push("}");

  return lines.join("\n");
}

function generateQueueSource(root: string, queues: WrapperFeatures["queues"]): string {
  const lines: string[] = [];

  // Import queue handler files
  for (let i = 0; i < queues.length; i++) {
    const absPath = join(root, "queues", queues[i].filePath);
    lines.push(`import handler${i} from "${absPath}";`);
  }

  lines.push("");
  lines.push("export async function handleQueue(batch, env, ctx) {");
  lines.push("  const queueSuffix = batch.queue;");
  lines.push("  const messages = [...batch.messages].map(m => ({");
  lines.push("    id: m.id,");
  lines.push("    timestamp: m.timestamp.toISOString(),");
  lines.push("    body: m.body,");
  lines.push("    attempts: m.attempts,");
  lines.push("  }));");
  lines.push("  const payload = { queue: queueSuffix, messages };");

  for (let i = 0; i < queues.length; i++) {
    const name = queues[i].name;
    lines.push("");
    lines.push(
      `  if (queueSuffix === ${JSON.stringify(name)} || queueSuffix.endsWith("-" + ${JSON.stringify(name)})) {`,
    );
    lines.push(`    if (typeof handler${i} === "function") {`);
    lines.push(`      await handler${i}(payload, env);`);
    lines.push(`    } else if (handler${i} && typeof handler${i}.default === "function") {`);
    lines.push(`      await handler${i}.default(payload, env);`);
    lines.push(`    }`);
    lines.push(`    return;`);
    lines.push(`  }`);
  }

  lines.push("}");

  return lines.join("\n");
}

function generateAuthSource(_providers: AuthProvider[]): string {
  const lines: string[] = [];

  lines.push(`import { authContext } from "__VOID_AUTH__";`);
  lines.push("export { authContext };");
  lines.push("");

  // Session resolution — parse cookie, look up in KV
  lines.push("const SESSION_COOKIE = '__void_session';");
  lines.push("");
  lines.push("export async function resolveSession(request, env) {");
  lines.push("  const cookie = request.headers.get('Cookie');");
  lines.push("  if (!cookie) return null;");
  lines.push(
    "  const match = cookie.match(new RegExp('(?:^|;\\\\s*)' + SESSION_COOKIE + '=([^;]+)'));",
  );
  lines.push("  if (!match) return null;");
  lines.push("  const sid = match[1];");
  lines.push("  try {");
  lines.push(`    const data = await env.AUTH_KV.get("session:" + sid, "json");`);
  lines.push("    if (!data || Date.now() > data.expiresAt) return null;");
  lines.push("    return {");
  lines.push("      id: data.userId,");
  lines.push("      provider: data.provider,");
  lines.push("      email: data.email,");
  lines.push("      name: data.name ?? null,");
  lines.push("      avatar_url: data.avatar_url ?? null,");
  lines.push("    };");
  lines.push("  } catch {");
  lines.push("    return null;");
  lines.push("  }");
  lines.push("}");
  lines.push("");

  // Auth route handler — delegates to existing void auth runtime
  // This is a minimal implementation that handles the core routes
  lines.push("export async function handleAuth(request, env, ctx, url) {");
  lines.push("  const method = request.method;");
  lines.push("  const path = url.pathname;");
  lines.push("");
  lines.push("  // GET /auth/me");
  lines.push(`  if (method === "GET" && path === "/auth/me") {`);
  lines.push("    const user = await resolveSession(request, env);");
  lines.push(
    `    if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });`,
  );
  lines.push(
    `    return new Response(JSON.stringify(user), { headers: { "Content-Type": "application/json" } });`,
  );
  lines.push("  }");
  lines.push("");
  lines.push("  // POST /auth/logout");
  lines.push(`  if (method === "POST" && path === "/auth/logout") {`);
  lines.push("    const cookie = request.headers.get('Cookie');");
  lines.push("    if (cookie) {");
  lines.push(
    "      const match = cookie.match(new RegExp('(?:^|;\\\\s*)' + SESSION_COOKIE + '=([^;]+)'));",
  );
  lines.push("      if (match) await env.AUTH_KV.delete('session:' + match[1]);");
  lines.push("    }");
  lines.push("    return new Response(JSON.stringify({ ok: true }), {");
  lines.push("      headers: {");
  lines.push('        "Content-Type": "application/json",');
  lines.push(
    "        \"Set-Cookie\": SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',",
  );
  lines.push("      },");
  lines.push("    });");
  lines.push("  }");
  lines.push("");
  lines.push(
    `  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });`,
  );
  lines.push("}");

  return lines.join("\n");
}
