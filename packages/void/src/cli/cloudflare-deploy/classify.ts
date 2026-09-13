import { isNodeTarget, type VoidConfig } from '../../config.ts';
import { scanJobsSync } from '../../crons/scan.ts';
import { scanDurableObjectModules } from '../../durable/scan.ts';
import { detectFramework } from '../../plugin-inference.ts';
import { assertNoRootSourceConventionConflicts, resolveProjectPaths } from '../../project-paths.ts';
import { scanWebSocketRoutesSync } from '../../router/websocket.ts';
import { validateSsrEntry } from '../../ssr/entry.ts';
import { detectPreset, FRAMEWORK_PRESETS, hasBackendFiles } from '../preset.ts';
import { syncWranglerDurableObjects, syncWranglerWebSockets } from '../wrangler.ts';

export type CloudflareDeployAppOptions = {
  dir?: string;
  spa?: boolean;
};

export type CloudflareDeployAppClassification =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * Narrow native Cloudflare deploys to app shapes whose emitted Worker artifact
 * the current verifier understands. This runs before any account operation.
 */
export function classifyCloudflareDeployApp(
  root: string,
  voidConfig: VoidConfig,
  options: CloudflareDeployAppOptions,
): CloudflareDeployAppClassification {
  if (isNodeTarget(voidConfig.target)) {
    return unsupported(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
  }

  const framework = detectFramework(root);
  if (framework) {
    const preset = FRAMEWORK_PRESETS[framework.name];
    if (!preset) {
      return unsupported(
        `deploy: --platform cloudflare has no deployment preset for framework ${framework.name}.`,
      );
    }
  }

  const staticPreset = detectPreset(root, { dir: options.dir, spa: options.spa });
  const configuredStatic =
    voidConfig.inference?.appType === 'static' || voidConfig.inference?.appType === 'spa';
  if (staticPreset || configuredStatic || options.dir || options.spa) {
    const appType = staticPreset?.appType ?? (options.spa ? 'spa' : 'static');
    return unsupported(
      [
        `deploy: --platform cloudflare could not resolve the ${appType} output to deploy.`,
        'Set inference.outputDir in void.json, pass --dir with an existing build directory,',
        'or add a supported build tool so Void can locate the generated static assets.',
      ].join('\n'),
    );
  }

  if (!framework && !hasBackendFiles(root)) {
    return unsupported(
      [
        'deploy: --platform cloudflare found no Void backend to deploy.',
        'A full Void app has at least one of: routes/, pages/, middleware, crons/, queues/,',
        'email/, or an SSR entry. Add your server code, or use `void deploy` for a static site.',
      ].join('\n'),
    );
  }

  const paths = resolveProjectPaths(root, voidConfig);
  try {
    assertNoRootSourceConventionConflicts(paths);
    validateSsrEntry(root, paths);
    scanJobsSync(root, paths.cronsDir);
    syncWranglerDurableObjects(root, scanDurableObjectModules(root));
    syncWranglerWebSockets(root, scanWebSocketRoutesSync(root, paths, 'prod'));
  } catch (error) {
    return unsupported(`deploy: ${getErrorMessage(error)}`);
  }

  return { supported: true };
}

function unsupported(reason: string): CloudflareDeployAppClassification {
  return { supported: false, reason };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
