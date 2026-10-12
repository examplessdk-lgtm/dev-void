import { existsSync } from 'node:fs';
import { createDeployArtifact, type DeployArtifact } from '@void/deploy-core';
import { resolve, join } from 'pathslash';
import { analyzeApplication } from './application-routing.ts';
import { resolveAssetConfig, hasApiRoutes, hasDocumentRoutes } from './asset-routing.ts';
import { resolveDistDir, resolveWorkerDirName } from './cli/build-output-dir.ts';
import { assertDeploySchemaDriftFree } from './cli/deploy-drift.ts';
import {
  resolveDeployWorkerMain,
  resolveDeployWranglerCompat,
  assertWorkerMainUploaded,
  validateDeployMigrations,
  toManifestSchedulesAndQueues,
} from './cli/deploy-helpers.ts';
import { mergeAndLintRoutingRules } from './cli/deploy-managed-events.ts';
import { assertManagedDurableStateSupported } from './cli/deploy-managed-framework.ts';
import { assembleVoidManifest } from './cli/deploy-managed-static.ts';
import { collectAndHashAssets, collectWorkerFiles } from './cli/package.ts';
import { readConfig, isNodeTarget } from './config.ts';
import { collectRevalidate } from './isr-config.ts';
import { hasEmailHandlers } from './router/email.ts';
import { validateSsrEntry } from './ssr/entry.ts';

export type PreparedDeployArtifact = {
  artifact: DeployArtifact;
  /** Static asset bytes keyed by URL path, encoded as base64. */
  assets: Record<string, string>;
};

/** Package an already-built Void app for managed deployment, without platform credentials. */
export async function prepareDeployArtifact(
  root: string = process.cwd(),
): Promise<PreparedDeployArtifact> {
  root = resolve(root);
  const config = readConfig(root);
  if (isNodeTarget(config.target) || config.output === 'static') {
    throw new Error('Artifact preparation requires a Void Cloudflare Worker build.');
  }
  assertManagedDurableStateSupported(root);
  const analysis = await analyzeApplication(root, { config, environment: 'prod' });
  if (analysis.bindings.needsSandbox || analysis.bindings.needsLive) {
    throw new Error(
      'Artifact preparation does not yet support Sandbox or Live resources. Use void deploy for those apps.',
    );
  }
  if (config.routing?.prerender?.length || config.remote) {
    throw new Error(
      'Artifact preparation requires a build without remote data or deploy-time prerendering.',
    );
  }
  const dist = resolveDistDir(root);
  const workerDir = join(dist, resolveWorkerDirName(dist));
  const clientDir = join(dist, 'client');
  const { paths, dialect, bindings, authEnabled, scan, websockets } = analysis;
  assertDeploySchemaDriftFree(root, dialect);
  const migrations = validateDeployMigrations(paths.migrationsDir, analysis.migrations);
  const { schedules, queues } = toManifestSchedulesAndQueues(analysis.jobs, analysis.queues);
  const pages = existsSync(paths.pagesDir);
  const ssr = Boolean(validateSsrEntry(root, paths)) || pages;
  const compat = resolveDeployWranglerCompat(root, config, workerDir, { authEnabled, dialect });
  const workerMain = resolveDeployWorkerMain(config, workerDir);
  const workerFiles = collectWorkerFiles(workerDir);
  if (!workerFiles.size) {
    throw new Error('Worker build output is missing. Run the app build first.');
  }
  assertWorkerMainUploaded(workerFiles, workerMain);
  const rules = mergeAndLintRoutingRules(clientDir, config.routing);
  const manifest = assembleVoidManifest(
    pages ? scan.pages : null,
    false,
    {
      bindings,
      hasEmailHandlers: scan.email !== undefined && hasEmailHandlers(scan.email),
      migrations,
      schedules,
      queues,
      dialect,
      webSockets: websockets,
      ssr:
        ssr ||
        scan.routes.length > 0 ||
        scan.middleware.length > 0 ||
        websockets.length > 0 ||
        authEnabled,
      revalidate: collectRevalidate(config, pages ? scan.pages : null),
      assetConfig: resolveAssetConfig({
        isSsr: ssr,
        hasPages: pages,
        hasApiRoutes: hasApiRoutes(scan.routes) || hasApiRoutes(websockets) || authEnabled,
        hasDocumentRoutes: hasDocumentRoutes(scan.routes),
        hasMiddleware: scan.middleware.length > 0,
        hasWebSockets: hasDocumentRoutes(websockets),
        authEnabled,
        liveEnabled: false,
        notFound: config.routing?.notFound,
      }),
      options: {
        compatibilityDate: compat?.compatibilityDate,
        compatibilityFlags: compat?.compatibilityFlags,
        cpuMs: config.worker?.limits?.cpu_ms,
        workerMain,
        revalidateQueryAllowlist: config.routing?.revalidateQueryAllowlist,
      },
      ...rules,
    },
    config.routing?.revalidate,
    config.routing?.isr !== false,
  );
  const { assetManifest, assetFiles } = await collectAndHashAssets(clientDir);
  return {
    artifact: createDeployArtifact({
      manifest,
      assetManifest,
      workerFiles: Object.fromEntries(
        [...workerFiles].map(([path, bytes]) => [path, bytes.toString('base64')]),
      ),
    }),
    assets: Object.fromEntries(
      [...assetFiles].map(([path, bytes]) => [path, bytes.toString('base64')]),
    ),
  };
}
