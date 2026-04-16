import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, extname } from 'node:path';
import { build } from 'vite';

export interface WrapperFeatures {
  /** Auth providers (kept for interface compat, no longer used by wrapper). */
  auth: string[] | null;
  /** Cron job definitions (from scanJobsSync). */
  crons: { name: string; filePath: string; crons: string[] }[];
  /** Queue consumer definitions (from scanQueuesSync). */
  queues: { name: string; filePath: string; bindingName: string }[];
  /** Whether migrations are present (framework deploys need a /__void/migrate endpoint). */
  hasMigrations?: boolean;
  /** Database dialect for migration handler. */
  migrationDialect?: 'sqlite' | 'postgresql';
}

export interface WrapperResult {
  /** Filename of the bundled entry module. */
  entryFilename: string;
  /** Absolute path to the directory containing the bundled output. */
  outputDir: string;
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
  let migrations: { name: string; sql: string }[] | undefined;
  if (features.hasMigrations) {
    const { collectMigrations } = await import('../migrations/collect');
    const migrationsDir = join(root, 'db', 'migrations');
    migrations = collectMigrations(migrationsDir);
    // Copy the migration handler runtime into the worker directory.
    // Pick the PG handler when the dialect is PostgreSQL, otherwise use the D1 handler.
    // Primary path: ../runtime/ relative to import.meta.dirname (dist/cli/ → dist/runtime/).
    const handlerFilename_ =
      features.migrationDialect === 'postgresql'
        ? 'migration-handler-pg.mjs'
        : 'migration-handler.mjs';
    let handlerPath = join(import.meta.dirname, '..', 'runtime', handlerFilename_);
    if (!existsSync(handlerPath)) {
      // Fallback for running from source (src/cli/) in tests — dist/runtime/ is two levels up.
      handlerPath = join(import.meta.dirname, '..', '..', 'dist', 'runtime', handlerFilename_);
    }
    if (!existsSync(handlerPath)) {
      throw new Error(
        `Migration handler not found: ${handlerFilename_}. Run "pnpm -C packages/void build" first.`,
      );
    }
    copyFileSync(handlerPath, join(workerDir, '__void_migration_handler.mjs'));
  }

  // Write wrapper in place of original entry
  const wrapperSource = generateWrapperSource(renamedName, handlerFilename, features, migrations);
  writeFileSync(join(workerDir, workerMain), wrapperSource);
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

  // Read actual output filename from the output directory
  const outFiles = readdirSync(outDir).filter((f) => f.startsWith('index'));
  const entryFilename = outFiles[0] ?? 'index.mjs';

  return { entryFilename, outputDir: outDir };
}

/**
 * Clean up generated wrapper/bundle files.
 */
export function cleanupWrapper(root: string): void {
  rmSync(join(root, '.void'), { recursive: true, force: true });
}

// ─── Source Generators ─────────────────────────────────────────────

function generateWrapperSource(
  renamedEntry: string,
  handlersModule: string,
  features: WrapperFeatures,
  migrations?: { name: string; sql: string }[],
): string {
  const lines: string[] = [];

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

    // Migration handler
    if (migrations && migrations.length > 0) {
      lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate") {');
      lines.push(
        '    const handler = createMigrationHandler(env, __migrations, __migrationDialect);',
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
  const lines: string[] = [];

  // Scheduled handlers
  if (features.crons.length > 0) {
    for (let i = 0; i < features.crons.length; i++) {
      const absPath = join(root, 'crons', features.crons[i].filePath).replaceAll('\\', '/');
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
      const absPath = join(root, 'queues', features.queues[i].filePath).replaceAll('\\', '/');
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
