import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'pathe';
import { loadEnv } from 'vite';
import { findVoidAuthConfig, loadVoidAuthConfig } from '../auth/config.ts';
import { generateVoidAuthDatabaseModule, generateVoidAuthDrizzleSchema } from '../auth/drizzle.ts';
import { getDatabaseDialect, readConfig } from '../config.ts';
import { discoverSchema } from '../drizzle/discover.ts';
import { FRAMEWORK_SCAN_DIRS, detectFramework, inferProjectBindings } from '../plugin-inference.ts';
import { scanRoutes } from '../router/scan.ts';
import { generateDbDts } from './db-types.ts';
import { findEnvFile, generateEnvTypes } from './env-types.ts';
import { ensureProjectTsconfig } from './project-tsconfig.ts';
import { generateQueueTypes } from './queue-types.ts';
import { generateRouteTypes } from './route-types.ts';

export interface PrepareProjectResult {
  written: Array<string>;
  removed: Array<string>;
}

function writeGeneratedFile(
  outDir: string,
  fileName: string,
  content: string,
  written: Array<string>,
): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, fileName), content);
  written.push(join('.void', fileName));
}

function removeGeneratedFile(outDir: string, fileName: string, removed: Array<string>): void {
  const filePath = join(outDir, fileName);
  if (!existsSync(filePath)) {
    return;
  }
  rmSync(filePath, { force: true });
  removed.push(join('.void', fileName));
}

export async function prepareProject(root: string): Promise<PrepareProjectResult> {
  const config = readConfig(root);
  const outDir = join(root, '.void');
  const written: Array<string> = [];
  const removed: Array<string> = [];

  mkdirSync(outDir, { recursive: true });

  const detectedFramework = detectFramework(root);
  const inferenceOptions = config.inference?.bindings
    ? { bindings: config.inference.bindings }
    : undefined;
  const scanDirs =
    config.inference?.scanDirs ?? (detectedFramework ? FRAMEWORK_SCAN_DIRS : undefined);
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);
  const authConfigPath = findVoidAuthConfig(root);
  const authEnabled = bindings.needsAuth || authConfigPath !== null || config.auth !== undefined;
  const dialect = getDatabaseDialect(config);

  const envFile = findEnvFile(root);
  if (envFile) {
    const { dts } = generateEnvTypes(envFile, outDir);
    writeGeneratedFile(outDir, 'env.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'env.d.ts', removed);
  }

  const scan = await scanRoutes(root, { output: config.output });
  const hasRouteTypes =
    scan.routes.length > 0 || (scan.websockets?.length ?? 0) > 0 || scan.pages.pages.length > 0;
  if (hasRouteTypes) {
    const { dts } = generateRouteTypes(scan, join(root, 'routes'), outDir, join(root, 'pages'));
    writeGeneratedFile(outDir, 'routes.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'routes.d.ts', removed);
  }

  if (scan.queues.length > 0) {
    const dts = generateQueueTypes(scan.queues, join(root, 'queues'), outDir);
    writeGeneratedFile(outDir, 'queues.d.ts', dts, written);
  } else {
    removeGeneratedFile(outDir, 'queues.d.ts', removed);
  }

  const schema = discoverSchema(root);
  const hasDbRuntime = schema != null || authEnabled;
  if (hasDbRuntime) {
    generateDbDts(outDir, schema, dialect);
    written.push(join('.void', 'db.d.ts'));
  } else {
    removeGeneratedFile(outDir, 'db.d.ts', removed);
  }

  if (authEnabled) {
    const authRuntime = {
      dialect,
      providers: config.auth?.providers ?? null,
      userConfig: await loadVoidAuthConfig(authConfigPath),
    };
    const env = loadEnv('development', root, '') as Record<string, unknown>;
    const schemaPath = join(outDir, 'better-auth-schema.ts');
    const databasePath = join(outDir, 'better-auth-db.ts');
    const drizzleAdapterPath = fileURLToPath(import.meta.resolve('better-auth/adapters/drizzle'));

    writeFileSync(schemaPath, generateVoidAuthDrizzleSchema(authRuntime, env));
    writeFileSync(
      databasePath,
      generateVoidAuthDatabaseModule({
        dialect,
        schemaImportPath: schemaPath,
        drizzleAdapterPath,
      }),
    );
    written.push(join('.void', 'better-auth-schema.ts'));
    written.push(join('.void', 'better-auth-db.ts'));
  } else {
    removeGeneratedFile(outDir, 'better-auth-schema.ts', removed);
    removeGeneratedFile(outDir, 'better-auth-db.ts', removed);
  }

  ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null);
  written.push(join('.void', 'tsconfig.json'));

  return { written, removed };
}
