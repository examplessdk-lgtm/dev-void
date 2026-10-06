import { join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';
import { scanJobs, type JobDefinition } from '../crons/scan.ts';
import { scanPages } from '../pages/scan.ts';
import type { PageScanResult } from '../pages/types.ts';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import { scanQueues, type QueueDefinition } from '../queues/scan.ts';
import { detectHttpExports } from './detect-exports.ts';
import { scanEmailHandlers, type EmailHandlersScan } from './email.ts';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  type RouteDefinition,
  type RouteEnvironment,
} from './parse-filename.ts';
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
  email?: EmailHandlersScan;
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
  options?: {
    output?: 'server' | 'static';
    paths?: ProjectPaths;
    environment?: RouteEnvironment;
    /** Reuse the inventories already resolved for this application phase. */
    inventory?: Omit<ScanResult, 'pages'>;
  },
): Promise<ScanResult> {
  const paths = options?.paths ?? readProjectPaths(root);
  const [routeFiles, websockets, middlewareFiles, jobs, queues, pages, email] = await Promise.all([
    options?.inventory ? [] : glob(ROUTE_PATTERN, { cwd: paths.routesDir, absolute: false }),
    options?.inventory?.websockets ?? scanWebSocketRoutes(root, paths, options?.environment),
    options?.inventory
      ? []
      : glob(ROUTE_PATTERN, { cwd: paths.middlewareDir, absolute: false }).catch(
          () => [] as Array<string>,
        ),
    options?.inventory?.jobs ?? scanJobs(root, paths.cronsDir),
    options?.inventory?.queues ?? scanQueues(root, paths.queuesDir),
    scanPages(root, { output: options?.output, paths }),
    // `email/` is a source convention like `crons/` and `queues/`, so it lives
    // under `sourceRoot` — which is `root` when no `sourceDir` is configured.
    // `scanEmailHandlers` joins its own `email` segment, so this resolves to
    // `paths.emailDir`.
    options?.inventory?.email ?? scanEmailHandlers(paths.sourceRoot),
  ]);

  const routesDir = paths.routesDir;

  // Parse routes, filtering out files starting with _
  const parsedRoutes =
    options?.inventory?.routes ??
    routeFiles
      .filter((f) => !isWebSocketPatternFile(f))
      .filter((f) => !f.split('/').some((s) => s.startsWith('_')))
      .map((file) => parseRouteFilename(file))
      .filter((route) => isRouteEnabledForEnvironment(route, options?.environment));
  const routes = parsedRoutes
    .map((route) => ({ ...route, methods: detectHttpExports(join(routesDir, route.filePath)) }))
    .sort(compareRouteSpecificity);

  // Parse middleware, sorted by numeric prefix
  const middleware = options?.inventory?.middleware ?? parseMiddlewareDefinitions(middlewareFiles);

  return { routes, websockets, middleware, jobs, queues, pages, email };
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
  environment?: RouteEnvironment,
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
    .filter((route) => isRouteEnabledForEnvironment(route, environment))
    .sort(compareRouteSpecificity);
}
