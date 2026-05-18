import type { AssetConfig } from './cli/types.ts';
import type { RouteDefinition } from './router/parse-filename.ts';

export type AssetRoutingInputs = {
  isSsr: boolean;
  hasPages: boolean;
  hasDocumentRoutes: boolean;
  hasMiddleware: boolean;
  hasWebSockets?: boolean;
  authEnabled?: boolean;
  liveEnabled?: boolean;
};

export type AssetRoutingPolicy = {
  assetConfig: AssetConfig;
  workerFirst: boolean;
  workerSpaFallback: boolean;
};

export function isApiRoutePattern(pattern: string): boolean {
  return pattern === '/api' || pattern.startsWith('/api/');
}

export function hasDocumentRoutes(routes: Array<Pick<RouteDefinition, 'pattern'>>): boolean {
  return routes.some((route) => !isApiRoutePattern(route.pattern));
}

/**
 * Returns true when browser document navigations must reach the worker before
 * a static asset fallback can serve HTML.
 */
export function workerOwnsHtmlRouting(inputs: AssetRoutingInputs): boolean {
  return (
    inputs.isSsr ||
    inputs.hasPages ||
    inputs.hasDocumentRoutes ||
    inputs.hasMiddleware ||
    inputs.hasWebSockets === true ||
    inputs.authEnabled === true ||
    inputs.liveEnabled === true
  );
}

export function resolveAssetConfig(inputs: AssetRoutingInputs): AssetConfig {
  return resolveAssetRoutingPolicy(inputs).assetConfig;
}

export function resolveAssetRoutingPolicy(inputs: AssetRoutingInputs): AssetRoutingPolicy {
  const workerFirst = workerOwnsHtmlRouting(inputs);
  const assetConfig: AssetConfig = workerFirst
    ? { not_found_handling: 'none', run_worker_first: ['/**'] }
    : { not_found_handling: 'single-page-application' };
  return {
    assetConfig,
    workerFirst,
    workerSpaFallback: workerFirst && !inputs.isSsr && !inputs.hasPages,
  };
}
