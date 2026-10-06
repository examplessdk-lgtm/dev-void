import { createDeployArtifact, createDeployUploadPayload } from '@void/deploy-core';
import { type SpinnerResult } from '@voidzero-dev/vite-plus-prompts';
import { type NotFoundHandling, type RoutingConfig } from '../config.ts';
import { getTokenSource } from './auth.ts';
import { PlatformClient, type ManifestOnlyDeployPayload } from './client.ts';
import {
  formatConnectionLostMessage,
  formatDeployFailureMessage,
  formatStreamDeployError,
} from './deploy-errors.ts';
import { log, DeployEventError } from './deploy-helpers.ts';
import { type ApplyDeployEventResult, type StreamDeployResult } from './deploy-types.ts';
import { uploadAssetsToR2, type DirectR2PutItem } from './direct-r2-upload.ts';
import { type GitDeployMetadata } from './git-metadata.ts';
import { lintDestinationSplats, lintDuplicateSources, mergeRoutingRules } from './headers.ts';
import { type CliLogger } from './log-file.ts';
import { formatCount } from './output.ts';
import { getAssetContentType, type AssetManifestEntry } from './package.ts';
import type { DeployEvent, DeployManifest } from './types.ts';

/**
 * Apply the visible side effects of a streamed deploy event (spinner
 * message or log warning). Returns a discriminated result so the caller
 * advances its own state (deploymentId capture, final return, error
 * throw). Pure function of (event, s) so the switch stays unit-testable.
 */
export function applyDeployEvent(event: DeployEvent, s: SpinnerResult): ApplyDeployEventResult {
  switch (event.event) {
    case 'start':
      s.message('Deploying...');
      return { kind: 'start', deploymentId: event.deploymentId };
    case 'heartbeat':
      if (event.status === 'recovering') {
        s.message('Recovering interrupted deployment...');
      }
      return { kind: 'continue' };
    case 'asset_upload':
      if (event.new > 0) {
        s.message(`Uploading assets (${event.new} new, ${event.cached} cached)`);
      } else {
        s.message(`Uploading assets (${event.total} cached)`);
      }
      return { kind: 'continue' };
    case 'provisioning':
      s.message(`Provisioning ${event.bindings.join(', ')}`);
      return { kind: 'continue' };
    case 'worker_readiness':
      s.message('Waiting for worker to become reachable...');
      return { kind: 'continue' };
    case 'migration_start':
      // `pending` counts every migration bundled with the build; the server
      // only learns which are unapplied while running them.
      s.message(`Checking ${event.pending} bundled migration${event.pending === 1 ? '' : 's'}...`);
      return { kind: 'continue' };
    case 'migration_warning':
      // log.warn persists above the spinner; a spinner message would be
      // overwritten by the next event.
      log.warn(event.message);
      return { kind: 'continue' };
    case 'migration':
      s.message(`Applied migration: ${event.name} (${event.durationMs}ms)`);
      return { kind: 'continue' };
    case 'worker_upload':
      s.message('Uploading worker...');
      return { kind: 'continue' };
    case 'queue_setup':
      s.message(`Configuring queue consumers: ${event.queues.join(', ')}`);
      return { kind: 'continue' };
    case 'queue_consumer_conflict':
      // log.warn persists above the spinner so the warning survives the
      // next s.message call — the user needs to see this after deploy
      // completes, not just as a transient spinner frame.
      log.warn(
        `Queue consumer conflict on "${event.queue}": owned by "${event.ownerScript}". ` +
          `Messages for this queue will not be delivered to this deployment ` +
          `until the owning script is removed.`,
      );
      return { kind: 'continue' };
    case 'prerender':
      s.message(`Prerendering ${event.pages} pages...`);
      return { kind: 'continue' };
    case 'done':
      if (event.published === false) {
        // Committed-live in the DB but routing KV was not published. The
        // deploy succeeded (do NOT throw / return an error kind) but the
        // project may be unreachable (first deploy) or still serving the
        // previous deploy (later deploy). Degrade the message accordingly.
        s.stop(
          'Deployed, but routing was not published — the project may be unreachable or still serving the previous deploy. Re-run `void deploy` to publish routing.',
        );
      } else {
        s.clear();
      }
      return { kind: 'done', event };
    case 'error':
      s.stop('Deploy failed');
      return { kind: 'error', message: event.message };
  }
  return { kind: 'continue' };
}

/**
 * Apply a streamed `DeployEvent` iterator to the spinner / cliLog and
 * resolve with the terminal `done` event (or throw on terminal error /
 * connection loss).
 */
export async function streamDeployEvents(
  projectId: string,
  events: AsyncGenerator<DeployEvent>,
  s: SpinnerResult,
  cliLog?: CliLogger,
): Promise<StreamDeployResult> {
  const startedAt = Date.now();
  let deploymentId: string | null = null;
  let lastProgressAt = startedAt;
  let waitNotice: string | undefined;
  let interrupted = false;
  cliLog?.info('stream_start', { projectId });
  const onSigint = () => {
    interrupted = true;
    s.stop('Deploy interrupted');
    if (deploymentId) {
      log.info(`Deployment: ${deploymentId}`);
    } else {
      log.info('Deployment id was not received before the interrupt.');
    }
    cliLog?.warn('stream_interrupted', { deploymentId });
    // Best-effort flush of the JSONL log before the process exits. The
    // returned promise is intentionally not awaited — `process.exit(130)`
    // would race the awaiter, and the OS flushes the page cache for the
    // line-delimited file regardless.
    cliLog?.close().catch(() => {});
    process.exit(130);
  };

  process.once('SIGINT', onSigint);

  try {
    for await (const event of events) {
      if (event.event === 'heartbeat') {
        const fields = {
          deploymentId,
          step: event.step,
          status: event.status,
          recoveryAt: event.recoveryAt,
        };
        if (event.status === 'recovering' && waitNotice !== 'recovering') {
          log.info(
            `Deployment ${deploymentId ?? event.deploymentId ?? ''} is recovering; waiting for its result.`,
          );
          cliLog?.info('deploy_recovering', fields);
          waitNotice = 'recovering';
        } else if (Date.now() - lastProgressAt >= 90_000 && waitNotice === undefined) {
          log.warn(
            `Deployment ${deploymentId ?? event.deploymentId ?? ''} has not reported new progress for 90 seconds (last reported progress: ${event.step.replaceAll('_', ' ')}).` +
              (event.recoveryAt
                ? ` Automatic recovery can start after ${event.recoveryAt} if execution was interrupted.`
                : '') +
              ' Inspect with `void project status`.',
          );
          cliLog?.warn('deploy_progress_stalled', fields);
          waitNotice = 'stalled';
        }
      } else {
        lastProgressAt = Date.now();
        waitNotice = undefined;
      }
      const result = applyDeployEvent(event, s);
      if (result.kind === 'start') {
        deploymentId = result.deploymentId;
        cliLog?.info('stream_deployment_id', { deploymentId });
      } else if (result.kind === 'done') {
        const degraded = result.event.published === false;
        // Degraded = committed-live but routing KV not published. Still a
        // `done` outcome (not an error), but logged distinctly so the
        // degraded result is greppable in the JSONL trace.
        cliLog?.info(degraded ? 'deploy_degraded' : 'deploy_success', {
          deploymentId,
          url: result.event.url,
          assets: result.event.assets,
          workers: result.event.workers,
          durationMs: Date.now() - startedAt,
          degraded,
        });
        return result.event;
      } else if (result.kind === 'error') {
        cliLog?.error('deploy_server_error', undefined, {
          deploymentId,
          message: result.message,
        });
        throw new DeployEventError(
          formatDeployFailureMessage(result.message, deploymentId, cliLog?.path ?? null),
        );
      }
    }
  } catch (err) {
    if (err instanceof DeployEventError || interrupted) {
      throw err;
    }
    cliLog?.error('stream_deploy_caught', err, { deploymentId });
    s.stop('Deploy failed');
    throw formatStreamDeployError(err, deploymentId, cliLog?.path ?? null);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  cliLog?.warn('stream_no_terminal_event', { deploymentId });
  s.stop('Deploy failed');
  throw new Error(formatConnectionLostMessage(deploymentId, cliLog?.path ?? null));
}

/**
 * Direct-to-R2 deploy orchestration. Issues presigned PUT URLs for each
 * needed asset, uploads bytes directly to R2, then calls the manifest-only
 * deploy endpoint to finalize.
 *
 * Key invariants:
 *   1. No needed assets → skip presign + R2 PUT phase entirely (saves a
 *      round-trip when every asset was already present from a prior deploy).
 *   2. Asset bytes come exclusively from the in-memory `assetFiles` cache
 *      computed by `collectAndHashAssets` — files are NEVER re-read from
 *      disk during this flow.
 *   3. R2 PUT failures (4xx, 5xx, network) are surfaced with the asset
 *      path + hash so the user can correlate against the JSONL trace.
 */
export async function streamDirectR2Deploy(
  client: PlatformClient,
  projectId: string,
  manifest: DeployManifest,
  assetManifest: Record<string, AssetManifestEntry>,
  assetFiles: Map<string, Buffer>,
  needed: Array<string>,
  gitMetadata: GitDeployMetadata | undefined,
  preflightUsed: boolean,
  workerFiles: Map<string, Buffer> | undefined,
  s: SpinnerResult,
  cliLog?: CliLogger,
): Promise<StreamDeployResult> {
  if (needed.length > 0) {
    // Memory: drop buffers for assets the server already has so peak
    // memory tracks `needed`, not the full bundle. Skipped entries become
    // GC-eligible immediately rather than after `finalizeDeploy` returns.
    // The pre-prune size is captured for the JSONL log only. We materialize
    // the key list before deleting so the iterator isn't disturbed mid-walk.
    const neededPaths = new Set(needed);
    const preBufferCount = assetFiles.size;
    const allPaths = Array.from(assetFiles.keys());
    for (const path of allPaths) {
      if (!neededPaths.has(path)) {
        assetFiles.delete(path);
      }
    }
    if (assetFiles.size !== preBufferCount) {
      cliLog?.info('asset_cache_pruned', {
        before: preBufferCount,
        after: assetFiles.size,
      });
    }

    s.message(`Requesting upload URLs for ${formatCount(needed.length, 'asset')}...`);

    // Dedupe by content hash: identical files (same blake3) get presigned
    // and PUT once. `assetManifest` still lists every path for the
    // per-path serving manifest the platform builds in `finalizeDeploy`;
    // this only collapses the upload phase. Common with prerendered HTML,
    // duplicated images, and framework-emitted twins.
    const seenBlake3 = new Set<string>();
    const uniqueNeeded: Array<string> = [];
    for (const path of needed) {
      const entry = assetManifest[path];
      if (!entry) {
        // Should never fire — `needed` is preflight's projection of
        // assetManifest. Defensive throw makes the cause obvious if a
        // future preflight regression slips through.
        throw new Error(`internal: preflight returned ${path} but assetManifest has no entry`);
      }
      if (seenBlake3.has(entry.blake3)) {
        continue;
      }
      seenBlake3.add(entry.blake3);
      uniqueNeeded.push(path);
    }

    const assetsToUpload = uniqueNeeded.map((path) => {
      const entry = assetManifest[path];
      return {
        blake3: entry.blake3,
        md5: entry.md5,
        size: entry.size,
        contentType: getAssetContentType(path),
      };
    });

    cliLog?.info('presign_request_start', {
      assetCount: assetsToUpload.length,
      dedupedFrom: needed.length,
    });
    const presignStartedAt = Date.now();
    const urls = await client.requestUploadUrls(projectId, assetsToUpload);
    cliLog?.info('presign_request_end', {
      urlsReceived: Object.keys(urls).length,
      durationMs: Date.now() - presignStartedAt,
    });

    // Map unique-by-hash paths → DirectR2PutItem, with the asset bytes
    // pulled from the in-memory cache (no disk reads here).
    const items: Array<DirectR2PutItem> = uniqueNeeded.map((path) => {
      const entry = assetManifest[path];
      const presigned = urls[entry.blake3];
      if (!presigned) {
        throw new Error(
          `Platform did not return an upload URL for ${path} (blake3=${entry.blake3}). ` +
            `This indicates a server-side bug or a stale client.`,
        );
      }
      const body = assetFiles.get(path);
      if (!body) {
        // Defensive — `uniqueNeeded` came from `assetManifest`, which was
        // constructed from `assetFiles`. If this fires, the upstream
        // collection diverged from preflight.
        throw new Error(
          `internal: asset ${path} declared in manifest but missing from buffer cache`,
        );
      }
      return {
        path,
        hash: entry.blake3,
        body,
        url: presigned.url,
        headers: presigned.headers,
      };
    });

    s.message(`Uploading ${formatCount(items.length, 'asset')} to R2...`);
    // Per-PUT cleanup: once R2 acks the upload, drop the buffer from the
    // CLI-side cache so peak memory under the bounded upload pool stays
    // close to `R2_PUT_CONCURRENCY` × asset size, not the full bundle.
    await uploadAssetsToR2(items, cliLog, undefined, (item) => {
      assetFiles.delete(item.path);
    });
  } else {
    // Fully reused Worker/static assets need no bytes during finalization.
    assetFiles.clear();
    cliLog?.info('presign_skipped', { reason: 'no_needed_assets' });
  }

  // Build the JSON-mode payload. Worker bytes go in as base64 — the
  // manifest-only endpoint's design (0068) keeps worker bundles in the
  // body since they are bounded at 32 MiB total.
  let encodedWorkerFiles: Record<string, string> | undefined;
  if (workerFiles && workerFiles.size > 0) {
    encodedWorkerFiles = {};
    for (const [relPath, buf] of workerFiles) {
      encodedWorkerFiles[relPath] = buf.toString('base64');
    }
  }
  const artifact = createDeployArtifact({
    manifest,
    assetManifest,
    workerFiles: encodedWorkerFiles,
  });
  const payload: ManifestOnlyDeployPayload = createDeployUploadPayload(artifact, {
    source: getTokenSource(),
    commit: gitMetadata?.commit ?? null,
    repositoryUrl: gitMetadata?.repositoryUrl ?? null,
    commitUrl: gitMetadata?.commitUrl ?? null,
    gitRef: gitMetadata?.gitRef ?? null,
    preflight: preflightUsed ? 'true' : null,
  });

  s.message('Finalizing deploy...');
  cliLog?.info('finalize_start', {
    workerFileCount: workerFiles?.size ?? 0,
    assetCount: Object.keys(assetManifest).length,
  });
  const finalizeStartedAt = Date.now();

  try {
    return await streamDeployEvents(
      projectId,
      client.finalizeDeploy(projectId, payload),
      s,
      cliLog,
    );
  } finally {
    cliLog?.info('finalize_end', { durationMs: Date.now() - finalizeStartedAt });
  }
}

/**
 * Surface a persistent warning when a deploy committed live but its routing
 * KV was not published. Uses `log.warn` (not the spinner) so the warning
 * survives the following `note`/`outro` calls and the user sees it after the
 * deploy summary. The deploy is still committed — this is a warning, not a
 * failure, so the process exit code is unaffected.
 */
export function warnUnpublishedRouting(result: StreamDeployResult): void {
  if (result.published !== false) {
    return;
  }
  log.warn(
    'Routing was not published for this deploy. The project may be unreachable (first deploy) or still serving the previous deploy. Re-run `void deploy` to publish routing.',
  );
}

/**
 * Merge `_headers` / `_redirects` in `dir` with `void.config.ts` routing rules
 * for a managed deploy, then lint each phase independently: duplicates across
 * phases (redirects vs fallbacks) don't shadow each other, only duplicates
 * within a phase do. Destinations with a literal `*` are flagged because only
 * `:name` tokens are substituted at dispatch time.
 */
export function mergeAndLintRoutingRules(
  dir: string,
  routing: RoutingConfig | undefined,
): ReturnType<typeof mergeRoutingRules> {
  const merged = mergeRoutingRules({ dir, routing });
  warnRedundantForceOn3xx(merged.redundantForceOn3xx);
  lintDuplicateSources(merged.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDuplicateSources(merged.fallbackRules, 'fallbacks (post-asset)');
  lintDestinationSplats(merged.redirectRules, 'redirects/rewrites (pre-asset)');
  lintDestinationSplats(merged.fallbackRules, 'fallbacks (post-asset)');
  return merged;
}

/**
 * Emit a single aggregated lint warning when a `_redirects` file contains
 * one or more `!` force suffixes on 3xx entries (e.g. `301!`, `302!`).
 * The `!` is a no-op on redirects — we parse them as if the `!` weren't
 * there — but we nudge the user to clean up for clarity. Silenced when
 * `count === 0`.
 */
export function warnRedundantForceOn3xx(count: number): void {
  if (count === 0) {
    return;
  }
  log.warn(
    `Found ${count} redundant "!" on 3xx entries in _redirects (these always force by nature; safe to remove).`,
  );
}

/**
 * Class B/C framework deploys pin `not_found_handling: 'none'`, so
 * `routing.notFound` does nothing there — say so instead of dropping it
 * silently.
 *
 * These presets emit no `run_worker_first`, so Cloudflare's default applies and
 * the asset layer answers before the framework worker: real prerendered files
 * already win. `not_found_handling` only governs what the framework's own
 * `env.ASSETS.fetch()` delegation returns, which is framework-internal
 * plumbing. Honoring the override there would be a behavior change, not a fix —
 * `single-page-application` makes an unmatched delegation return
 * `dist/client/index.html` at **200** (Astro/SvelteKit hybrid builds commonly
 * prerender the root, so real 404s silently become the home page), and
 * `404-page` steals the 404 from the framework's own error route.
 *
 * Silenced when unset.
 */
export function warnIgnoredNotFoundForFramework(
  notFound: NotFoundHandling | undefined,
  frameworkName: string,
): void {
  if (notFound === undefined) {
    return;
  }
  log.warn(
    `"routing.notFound" in void.config.ts is ignored for ${frameworkName} deploys ` +
      `(not_found_handling is pinned to "none" — the framework's own worker owns unmatched HTML).`,
  );
}
