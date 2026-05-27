import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, extname } from 'pathe';
import { build } from 'vite';
import type { MigrationPlanBundle } from '../migrations/plan.ts';
import { readProjectPaths } from '../project-paths.ts';

export type WrapperFeatures = {
  /** Auth providers (kept for type compatibility, no longer used by wrapper). */
  auth: Array<string> | null;
  /** Cron job definitions (from scanJobsSync). */
  crons: Array<{ name: string; filePath: string; crons: Array<string> }>;
  /** Queue consumer definitions (from scanQueuesSync). */
  queues: Array<{ name: string; filePath: string; bindingName: string }>;
  /** Whether migrations are present (framework deploys need a /__void/migrate endpoint). */
  hasMigrations?: boolean;
  /** Database dialect for migration handler. */
  migrationDialect?: 'sqlite' | 'postgresql';
};

export type WrapperResult = {
  /** Filename of the bundled entry module. */
  entryFilename: string;
  /** Absolute path to the directory containing the bundled output. */
  outputDir: string;
};

const BUNDLED_ENTRY_RE = /^index\.(?:m?js|cjs)$/;

export function selectBundledEntryFilename(outFiles: Array<string>): string {
  const entryFilename = outFiles.find((file) => BUNDLED_ENTRY_RE.test(file));
  if (!entryFilename) {
    throw new Error(
      `deploy: Bundled worker entry not found. Expected index.js, index.mjs, or index.cjs in bundle output. Found: ${outFiles.join(', ') || '(none)'}`,
    );
  }
  return entryFilename;
}

/**
 * Determine whether a wrapper is needed based on the features.
 */
export function needsWrapper(features: WrapperFeatures): boolean {
  return features.crons.length > 0 || features.queues.length > 0 || !!features.hasMigrations;
}

/**
 * Generate a wrapper entry in-place in the worker directory.
 *
 * - Renames the original entry (e.g. `index.js` → `__original.js`)
 * - Compiles cron/queue handlers via a small Vite build
 * - Writes a wrapper module as the original entry name that imports
 *   the renamed original + compiled handlers
 *
 * The original worker code is never re-bundled.
 */
export async function generateWrapper(
  workerDir: string,
  workerMain: string,
  root: string,
  features: WrapperFeatures,
): Promise<void> {
  const ext = extname(workerMain) || '.js';
  const renamedName = `__original${ext}`;

  // Rename original entry
  renameSync(join(workerDir, workerMain), join(workerDir, renamedName));

  // Compile cron/queue handlers if needed (small focused build — user source is TypeScript)
  let handlerFilename = '__void_handlers.mjs';
  if (features.crons.length > 0 || features.queues.length > 0) {
    const tmpDir = join(root, '.void', 'handlers');
    mkdirSync(tmpDir, { recursive: true });
    const handlersSource = generateHandlersSource(root, features);
    const handlersEntry = join(tmpDir, 'handlers.ts');
    writeFileSync(handlersEntry, handlersSource);

    const outDir = join(tmpDir, 'out');
    await build({
      root: tmpDir,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        lib: {
          entry: handlersEntry,
          formats: ['es'],
          fileName: '__void_handlers',
        },
        rollupOptions: {
          external: [/^cloudflare:/, /^node:/],
        },
        minify: false,
        target: 'esnext',
      },
    });

    // Find the actual output filename and copy to worker dir
    const handlerFiles = readdirSync(outDir).filter((f) => f.startsWith('__void_handlers'));
    handlerFilename = handlerFiles[0] ?? '__void_handlers.mjs';
    copyFileSync(join(outDir, handlerFilename), join(workerDir, handlerFilename));
  }

  // Collect migrations and copy handler if needed
  let migrations: Array<{ name: string; sql: string }> | undefined;
  let migrationPlanBundle: MigrationPlanBundle | undefined;
  if (features.hasMigrations) {
    const { collectMigrations } = await import('../migrations/collect.ts');
    const { buildMigrationPlanBundle } = await import('../migrations/plan.ts');
    const migrationsDir = readProjectPaths(root).migrationsDir;
    migrations = collectMigrations(migrationsDir);
    migrationPlanBundle =
      features.migrationDialect === 'sqlite' ? buildMigrationPlanBundle(migrations) : undefined;
    const handlerName =
      features.migrationDialect === 'postgresql' ? 'migration-handler-pg' : 'migration-handler';
    const handlerFilename_ = `${handlerName}.mjs`;
    let handlerPath = join(import.meta.dirname, '..', 'runtime', `${handlerName}.ts`);
    if (!existsSync(handlerPath)) {
      handlerPath = join(import.meta.dirname, 'runtime', handlerFilename_);
    }
    if (!existsSync(handlerPath)) {
      handlerPath = join(import.meta.dirname, '..', 'runtime', handlerFilename_);
    }
    if (!existsSync(handlerPath)) {
      // Fallback for running from source (src/cli/) in tests — dist/runtime/ is two levels up.
      handlerPath = join(import.meta.dirname, '..', '..', 'dist', 'runtime', handlerFilename_);
    }
    if (!existsSync(handlerPath)) {
      throw new Error(
        `Migration handler not found: ${handlerFilename_}. Run "pnpm -C packages/void build" first.`,
      );
    }
    if (features.migrationDialect === 'postgresql') {
      await bundlePgMigrationHandler(root, workerDir, handlerPath);
    } else {
      copyFileSync(handlerPath, join(workerDir, '__void_migration_handler.mjs'));
    }
  }

  // Write wrapper in place of original entry
  const wrapperSource = generateWrapperSource(
    renamedName,
    handlerFilename,
    features,
    migrations,
    migrationPlanBundle,
  );
  writeFileSync(join(workerDir, workerMain), wrapperSource);
}

async function bundlePgMigrationHandler(
  root: string,
  workerDir: string,
  handlerPath: string,
): Promise<void> {
  const tmpDir = join(root, '.void', 'migration-handler');
  mkdirSync(tmpDir, { recursive: true });
  const outDir = join(tmpDir, 'out');
  await build({
    root: tmpDir,
    logLevel: 'silent',
    resolve: {
      alias: {
        'pg-cloudflare': resolvePgCloudflareWorkerdEntry(handlerPath),
        'pg-pool': resolvePgCjsDependency(handlerPath, 'pg-pool'),
      },
      conditions: ['workerd', 'worker', 'browser', 'module', 'import', 'default'],
    },
    ssr: {
      noExternal: ['pg', 'pg-cloudflare'],
      resolve: {
        conditions: ['workerd', 'worker', 'browser', 'module', 'import', 'default'],
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: handlerPath,
      target: 'esnext',
      rollupOptions: {
        input: handlerPath,
        external: [/^cloudflare:/, /^node:/, /^pgpass$/],
        output: {
          entryFileNames: '__void_migration_handler.mjs',
          chunkFileNames: '__void_migration_handler-[hash].mjs',
        },
      },
    },
  });

  patchPgWorkerBundle(outDir);
  for (const file of readdirSync(outDir)) {
    copyFileSync(join(outDir, file), join(workerDir, file));
  }
}

function patchPgWorkerBundle(outDir: string): void {
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) {
      continue;
    }
    const path = join(outDir, file);
    let code = readFileSync(path, 'utf-8');
    if (!code.includes('__require("pgpass")') && !code.includes('createRequire(import.meta.url)')) {
      continue;
    }
    code = code
      .replaceAll('__require("pgpass")', '__voidPgpassNoop')
      .replace('import { createRequire } from "node:module";', '')
      .replace(
        'var __require = /* @__PURE__ */ createRequire(import.meta.url);',
        pgWorkerRequireShim(),
      );
    code =
      `const __voidPgpassNoop = Object.assign(function pgpass(_connectionInfo, callback) { callback(undefined); }, { warnTo() {} });\n` +
      code;
    writeFileSync(path, code);
  }
}

function createPgPackageRequire(fromPath: string): NodeJS.Require {
  const fromRequire = createRequire(fromPath);
  return createRequire(fromRequire.resolve('pg/package.json'));
}

function resolvePgCjsDependency(fromPath: string, specifier: string): string {
  return createPgPackageRequire(fromPath).resolve(specifier);
}

function resolvePgCloudflareWorkerdEntry(fromPath: string): string {
  const packageJsonPath = createPgPackageRequire(fromPath).resolve('pg-cloudflare/package.json');
  return join(dirname(packageJsonPath), 'dist', 'index.js');
}

function pgWorkerRequireShim(): string {
  return [
    'import * as __voidNodeCrypto from "node:crypto";',
    'import * as __voidNodeDns from "node:dns";',
    'import * as __voidNodeEvents from "node:events";',
    'import * as __voidNodeFs from "node:fs";',
    'import * as __voidNodeNet from "node:net";',
    'import * as __voidNodeTls from "node:tls";',
    'import * as __voidNodeUtil from "node:util";',
    'import * as __voidNodeUtilTypes from "node:util/types";',
    'var __voidNodeRequireModules = {',
    '  crypto: __voidNodeCrypto,',
    '  dns: __voidNodeDns,',
    '  events: __voidNodeEvents,',
    '  fs: __voidNodeFs,',
    '  net: __voidNodeNet,',
    '  tls: __voidNodeTls,',
    '  util: __voidNodeUtil,',
    '  "util/types": __voidNodeUtilTypes,',
    '};',
    'var __require = (id) => {',
    '  if (id.startsWith("node:")) id = id.slice(5);',
    '  const mod = __voidNodeRequireModules[id];',
    '  if (mod) return mod;',
    '  throw new Error(`Unsupported require("${id}") in Void PG migration bundle`);',
    '};',
  ].join('\n');
}

/**
 * Bundle a worker entry into a self-contained module.
 *
 * Used for frameworks whose build output has unbundled bare imports
 * (e.g. SvelteKit's `_worker.js` imports from `@sveltejs/kit`).
 */
export async function bundleEntry(root: string, entry: string): Promise<WrapperResult> {
  const tmpDir = join(root, '.void', 'bundle');
  mkdirSync(tmpDir, { recursive: true });
  const outDir = join(tmpDir, 'out');
  await build({
    root: tmpDir,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry,
        formats: ['es'],
        fileName: 'index',
      },
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: {
          // Workers for Platforms restricts caches.default access.
          // Stub it so framework code (e.g. SvelteKit) that uses it doesn't throw.
          banner: [
            'const __noopCache = {',
            '  match() { return Promise.resolve(undefined); },',
            '  put() { return Promise.resolve(); },',
            '  delete() { return Promise.resolve(false); },',
            '};',
            'globalThis.caches = { default: __noopCache, open() { return Promise.resolve(__noopCache); } };',
          ].join('\n'),
        },
      },
      minify: false,
      target: 'esnext',
    },
  });

  // Read actual entry filename from the output directory. Vite/Rollup can also
  // emit sibling chunks like index-server-*.js, and readdir order is
  // filesystem-dependent.
  const entryFilename = selectBundledEntryFilename(readdirSync(outDir));

  return { entryFilename, outputDir: outDir };
}

/**
 * Clean up generated wrapper/bundle files. Preserves `dev-trigger-token`
 * across the wipe so that subsequent `void dev` sessions keep using the
 * same UUID — invalidating it on every deploy would force users to update
 * any saved curl scripts that exercise `/__void/{scheduled,queue}`.
 */
export function cleanupWrapper(root: string): void {
  const voidDir = join(root, '.void');
  const tokenPath = join(voidDir, 'dev-trigger-token');
  let preservedToken: string | undefined;
  if (existsSync(tokenPath)) {
    try {
      preservedToken = readFileSync(tokenPath, 'utf-8');
    } catch {
      // Best-effort — fall through and let the next dev session regenerate.
    }
  }
  rmSync(voidDir, { recursive: true, force: true });
  if (preservedToken !== undefined) {
    mkdirSync(voidDir, { recursive: true });
    writeFileSync(tokenPath, preservedToken);
  }
}

// ─── Source Generators ─────────────────────────────────────────────

function generateWrapperSource(
  renamedEntry: string,
  handlersModule: string,
  features: WrapperFeatures,
  migrations?: Array<{ name: string; sql: string }>,
  migrationPlanBundle?: MigrationPlanBundle,
): string {
  const lines: Array<string> = [];

  lines.push(`import original from "./${renamedEntry}";`);

  if (features.crons.length > 0) {
    lines.push(`import { handleScheduled } from "./${handlersModule}";`);
  }
  if (features.queues.length > 0) {
    lines.push(`import { handleQueue } from "./${handlersModule}";`);
  }
  if (migrations && migrations.length > 0) {
    lines.push(`import { createMigrationHandler } from "./__void_migration_handler.mjs";`);
    lines.push(`const __migrations = ${JSON.stringify(migrations)};`);
    lines.push(`const __migrationPlanBundle = ${JSON.stringify(migrationPlanBundle)};`);
    lines.push(
      `const __migrationDialect = ${JSON.stringify(features.migrationDialect ?? 'sqlite')};`,
    );
  }

  lines.push('');

  // Wrap fetch if any intercepted routes are needed
  const needsFetchWrap = features.crons.length > 0 || (migrations && migrations.length > 0);

  if (needsFetchWrap) {
    lines.push('async function wrappedFetch(request, env, ctx) {');
    lines.push('  const url = new URL(request.url);');

    // Readiness probe — platform polls this to confirm the worker is live
    // after WfP upload. Handled here (before original.fetch) so the user's
    // framework handler doesn't route it to env.ASSETS, which returns CF's
    // "Assets have not yet been deployed" stub during asset propagation
    // and would trip the platform's probe.
    lines.push('  if (request.method === "GET" && url.pathname === "/__void/ready") {');
    lines.push('    return Response.json({ ready: true });');
    lines.push('  }');

    // Migration handler
    if (migrations && migrations.length > 0) {
      lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate") {');
      lines.push(
        '    const handler = createMigrationHandler(env, __migrations, __migrationDialect);',
      );
      lines.push('    return handler(request);');
      lines.push('  }');
      lines.push(
        '  if (request.method === "GET" && url.pathname === "/__void/migrate/capabilities") {',
      );
      lines.push(
        '    const handler = createMigrationHandler(env, __migrations, __migrationDialect, undefined, __migrationPlanBundle);',
      );
      lines.push('    return handler(request);');
      lines.push('  }');
      lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate/app") {');
      lines.push(
        '    const handler = createMigrationHandler(env, __migrations, __migrationDialect, undefined, __migrationPlanBundle);',
      );
      lines.push('    return handler(request);');
      lines.push('  }');
      lines.push(
        '  if (request.method === "GET" && url.pathname.startsWith("/__void/migrate/app/attempt/")) {',
      );
      lines.push(
        '    const handler = createMigrationHandler(env, __migrations, __migrationDialect, undefined, __migrationPlanBundle);',
      );
      lines.push('    return handler(request);');
      lines.push('  }');
    }

    // Cron handler
    if (features.crons.length > 0) {
      lines.push('  if (request.method === "POST" && url.pathname === "/__void/scheduled") {');
      lines.push('    const __token = request.headers.get("x-void-internal");');
      lines.push('    const __expected = env?.__VOID_PROXY_TOKEN || env?.CRON_SECRET;');
      lines.push('    if (__expected && __token !== __expected) {');
      lines.push("      return new Response(JSON.stringify({ error: 'unauthorized' }), {");
      lines.push('        status: 401,');
      lines.push('        headers: { "Content-Type": "application/json" },');
      lines.push('      });');
      lines.push('    }');
      lines.push('    try {');
      lines.push('      const { cron, scheduledTime } = await request.json();');
      lines.push('      const controller = { cron, scheduledTime, noRetry() {} };');
      lines.push('      await handleScheduled(controller, env, ctx);');
      lines.push('      return new Response(JSON.stringify({ ok: true }), {');
      lines.push('        headers: { "Content-Type": "application/json" },');
      lines.push('      });');
      lines.push('    } catch (err) {');
      lines.push('      return new Response(JSON.stringify({ error: String(err) }), {');
      lines.push('        status: 500,');
      lines.push('        headers: { "Content-Type": "application/json" },');
      lines.push('      });');
      lines.push('    }');
      lines.push('  }');
    }

    lines.push('  return original.fetch(request, env, ctx);');
    lines.push('}');
    lines.push('');
  }

  lines.push('export default {');

  if (needsFetchWrap) {
    lines.push('  fetch: wrappedFetch,');
  } else {
    lines.push('  fetch: original.fetch,');
  }

  if (features.crons.length > 0) {
    lines.push('  scheduled: handleScheduled,');
  }

  if (features.queues.length > 0) {
    lines.push('  queue: handleQueue,');
  }

  lines.push('};');

  return lines.join('\n');
}

function generateHandlersSource(root: string, features: WrapperFeatures): string {
  const lines: Array<string> = [];
  const paths = readProjectPaths(root);

  // Scheduled handlers
  if (features.crons.length > 0) {
    for (let i = 0; i < features.crons.length; i++) {
      const absPath = join(paths.cronsDir, features.crons[i].filePath);
      lines.push(`import cronHandler${i} from "${absPath}";`);
    }

    lines.push('');
    lines.push('export async function handleScheduled(controller, env, ctx) {');
    lines.push('  switch (controller.cron) {');

    for (let i = 0; i < features.crons.length; i++) {
      for (const expr of features.crons[i].crons) {
        lines.push(`    case ${JSON.stringify(expr)}:`);
      }
      lines.push(`      if (typeof cronHandler${i} === "function") {`);
      lines.push(`        await cronHandler${i}(controller, env, ctx);`);
      lines.push(
        `      } else if (cronHandler${i} && typeof cronHandler${i}.default === "function") {`,
      );
      lines.push(`        await cronHandler${i}.default(controller, env, ctx);`);
      lines.push(`      }`);
      lines.push(`      return;`);
    }

    lines.push('  }');
    lines.push('}');
  }

  // Queue handlers
  if (features.queues.length > 0) {
    lines.push('');
    for (let i = 0; i < features.queues.length; i++) {
      const absPath = join(paths.queuesDir, features.queues[i].filePath);
      lines.push(`import queueHandler${i} from "${absPath}";`);
    }

    lines.push('');
    lines.push('export async function handleQueue(batch, env, ctx) {');
    lines.push('  const queueSuffix = batch.queue;');
    lines.push('  const messages = [...batch.messages].map(m => ({');
    lines.push('    id: m.id,');
    lines.push('    timestamp: m.timestamp.toISOString(),');
    lines.push('    body: m.body,');
    lines.push('    attempts: m.attempts,');
    lines.push('  }));');
    lines.push('  const payload = { queue: queueSuffix, messages };');

    for (let i = 0; i < features.queues.length; i++) {
      const name = features.queues[i].name;
      lines.push('');
      lines.push(
        `  if (queueSuffix === ${JSON.stringify(name)} || queueSuffix.endsWith("-" + ${JSON.stringify(name)})) {`,
      );
      lines.push(`    if (typeof queueHandler${i} === "function") {`);
      lines.push(`      await queueHandler${i}(payload, env);`);
      lines.push(
        `    } else if (queueHandler${i} && typeof queueHandler${i}.default === "function") {`,
      );
      lines.push(`      await queueHandler${i}.default(payload, env);`);
      lines.push(`    }`);
      lines.push(`    return;`);
      lines.push(`  }`);
    }

    lines.push('}');
  }

  return lines.join('\n');
}
