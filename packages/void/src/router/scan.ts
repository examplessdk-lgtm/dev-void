import { join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';
import { scanJobs, type JobDefinition } from '../crons/scan.ts';
import { scanPages } from '../pages/scan.ts';
import type { PageScanResult } from '../pages/types.ts';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
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

function parseMiddlewareDefinitions(files: Array<string>): Array<MiddlewareDefinition> {
  return files
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
}

// Order by specificity (static < dynamic param < catch-all, depth-first); Hono resolves overlap by registration order.
function compareRouteSpecificity(a: RouteDefinition, b: RouteDefinition): number {
  if (a.catchAll !== b.catchAll) {
    return a.catchAll ? 1 : -1;
  }
  const aSegments = a.pattern.split('/');
  const bSegments = b.pattern.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const aDynamic = aSegments[i].startsWith(':') || aSegments[i] === '*';
    const bDynamic = bSegments[i].startsWith(':') || bSegments[i] === '*';
    if (aDynamic !== bDynamic) {
      return aDynamic ? 1 : -1;
    }
    if (aSegments[i] !== bSegments[i]) {
      return aSegments[i].localeCompare(bSegments[i]);
    }
  }
  return aSegments.length - bSegments.length;
}

/**
 * Scan routes/ and middleware/ directories and return a structured manifest.
 * Files starting with _ are ignored.
 */
export async function scanRoutes(
  root: string,
  options?: { output?: 'server' | 'static'; paths?: ProjectPaths },
): Promise<ScanResult> {
  const paths = options?.paths ?? readProjectPaths(root);
  const [routeFiles, websockets, middlewareFiles, jobs, queues, pages] = await Promise.all([
    glob(ROUTE_PATTERN, { cwd: paths.routesDir, absolute: false }),
    scanWebSocketRoutes(root, paths),
    glob(ROUTE_PATTERN, { cwd: paths.middlewareDir, absolute: false }).catch(
      () => [] as Array<string>,
    ),
    scanJobs(root, paths.cronsDir),
    scanQueues(root, paths.queuesDir),
    scanPages(root, { output: options?.output, paths }),
  ]);

  const routesDir = paths.routesDir;

  // Parse routes, filtering out files starting with _
  const routes = routeFiles
    .filter((f) => !isWebSocketPatternFile(f))
    .filter((f) => !f.split('/').some((s) => s.startsWith('_')))
    .map((f) => {
      const route = parseRouteFilename(f);
      route.methods = detectHttpExports(join(routesDir, f));
      return route;
    })
    // Sort by specificity: static routes before dynamic params, catch-all last.
    .sort(compareRouteSpecificity);

  // Parse middleware, sorted by numeric prefix
  const middleware = parseMiddlewareDefinitions(middlewareFiles);

  return { routes, websockets, middleware, jobs, queues, pages };
}

export function scanMiddlewareSync(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): Array<MiddlewareDefinition> {
  let middlewareFiles: Array<string>;
  try {
    middlewareFiles = globSync(ROUTE_PATTERN, { cwd: paths.middlewareDir, absolute: false });
  } catch {
    middlewareFiles = [];
  }

  return parseMiddlewareDefinitions(middlewareFiles);
}

export function scanRoutePatternsSync(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): Array<RouteDefinition> {
  let routeFiles: Array<string>;
  try {
    routeFiles = globSync(ROUTE_PATTERN, { cwd: paths.routesDir, absolute: false });
  } catch {
    routeFiles = [];
  }

  return routeFiles
    .filter((f) => !isWebSocketPatternFile(f))
    .filter((f) => !f.split('/').some((s) => s.startsWith('_')))
    .map((f) => parseRouteFilename(f))
    .sort(compareRouteSpecificity);
}
