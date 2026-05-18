import { join } from 'pathe';
import { glob, globSync } from 'tinyglobby';
import { scanJobs, type JobDefinition } from '../crons/scan.ts';
import { scanPages } from '../pages/scan.ts';
import type { PageScanResult } from '../pages/types.ts';
import { scanQueues, type QueueDefinition } from '../queues/scan.ts';
import { detectHttpExports } from './detect-exports.ts';
import { parseRouteFilename, type RouteDefinition } from './parse-filename.ts';
import {
  isWebSocketPatternFile,
  scanWebSocketRoutes,
  type WebSocketRouteDefinition,
} from './websocket.ts';

export type ScanResult = {
  routes: Array<RouteDefinition>;
  websockets?: Array<WebSocketRouteDefinition>;
  middleware: Array<MiddlewareDefinition>;
  jobs: Array<JobDefinition>;
  queues: Array<QueueDefinition>;
  pages: PageScanResult;
};

export type MiddlewareDefinition = {
  /** Numeric order prefix (e.g. 1 for "01.logger.ts") */
  order: number;
  /** Original filename */
  filePath: string;
};

const HANDLER_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];
const ROUTE_PATTERN = `**/*.{${HANDLER_EXTENSIONS.join(',')}}`;

/**
 * Scan routes/ and middleware/ directories and return a structured manifest.
 * Files starting with _ are ignored.
 */
export async function scanRoutes(
  root: string,
  options?: { output?: 'server' | 'static' },
): Promise<ScanResult> {
  const [routeFiles, websockets, middlewareFiles, jobs, queues, pages] = await Promise.all([
    glob(ROUTE_PATTERN, { cwd: `${root}/routes`, absolute: false }),
    scanWebSocketRoutes(root),
    glob(ROUTE_PATTERN, { cwd: `${root}/middleware`, absolute: false }).catch(
      () => [] as Array<string>,
    ),
    scanJobs(root),
    scanQueues(root),
    scanPages(root, { output: options?.output }),
  ]);

  const routesDir = `${root}/routes`;

  // Parse routes, filtering out files starting with _
  const routes = routeFiles
    .filter((f) => !isWebSocketPatternFile(f))
    .filter((f) => !f.split('/').some((s) => s.startsWith('_')))
    .map((f) => {
      const route = parseRouteFilename(f);
      route.methods = detectHttpExports(join(routesDir, f));
      return route;
    })
    // Sort: static routes before dynamic, catch-all last
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) {
        return a.catchAll ? 1 : -1;
      }
      return a.pattern.localeCompare(b.pattern);
    });

  // Parse middleware, sorted by numeric prefix
  const middleware = middlewareFiles
    .filter((f) => !f.startsWith('_'))
    .map((f) => {
      const basename = f.split('/').pop()!;
      const match = basename.match(/^(\d+)\./);
      return {
        order: match ? parseInt(match[1], 10) : Infinity,
        filePath: f,
      };
    })
    .sort((a, b) => a.order - b.order);

  return { routes, websockets, middleware, jobs, queues, pages };
}

export function scanRoutePatternsSync(root: string): Array<RouteDefinition> {
  let routeFiles: Array<string>;
  try {
    routeFiles = globSync(ROUTE_PATTERN, { cwd: `${root}/routes`, absolute: false });
  } catch {
    routeFiles = [];
  }

  return routeFiles
    .filter((f) => !isWebSocketPatternFile(f))
    .filter((f) => !f.split('/').some((s) => s.startsWith('_')))
    .map((f) => parseRouteFilename(f))
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) {
        return a.catchAll ? 1 : -1;
      }
      return a.pattern.localeCompare(b.pattern);
    });
}
