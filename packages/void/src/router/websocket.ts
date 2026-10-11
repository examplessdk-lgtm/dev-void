import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { globSync } from 'tinyglobby';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import {
  isIdentifier,
  isLiteral,
  isObjectExpression,
  type AstNode,
  type AstProperty,
} from '../shared/ast.ts';
import { readResourceDefinition } from '../shared/resource-definition.ts';
import { resourceNameWords } from '../shared/resource-name.ts';
import {
  isRouteEnabledForEnvironment,
  parseWebSocketFilename,
  type RouteDefinition,
  type RouteEnvironment,
} from './parse-filename.ts';

const HANDLER_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];
const WEBSOCKET_ROUTE_RE = /(?:\.(?:dev|prod))?\.ws\.(?:ts|mts|js|mjs)$/;

export type WebSocketRouteDefinition = RouteDefinition & {
  className: string;
  bindingName: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
  name?: string;
};

type WebSocketSourceInfo = {
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
  name?: string;
};

function isWebSocketRouteFile(filePath: string): boolean {
  return WEBSOCKET_ROUTE_RE.test(filePath.replace(/\\/g, '/'));
}

function identifierWords(segment: string): Array<string> {
  const normalized = segment
    .replace(/^\(\s*|\s*\)$/g, '')
    .replace(/^\[\.\.\.(.+)\]$/, '$1')
    .replace(/^\[(.+)\]$/, '$1')
    .replace(/\.ws$/, '')
    .replace(/\.(dev|prod)$/, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ');

  return normalized.split(' ').filter(Boolean);
}

export function deriveWebSocketClassNameFromName(name: string): string {
  return (
    resourceNameWords(name)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('') + 'Ws'
  );
}

export function inferWebSocketResourceName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\.(ts|mts|js|mjs)$/, '');
  const parts = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && !(segment.startsWith('(') && segment.endsWith(')')))
    .flatMap(identifierWords);

  return parts.length > 0 ? parts.join('-') : 'WebSocket';
}

export function deriveWebSocketClassName(filePath: string): string {
  return deriveWebSocketClassNameFromName(inferWebSocketResourceName(filePath));
}

function getPropertyName(node: AstNode | undefined): string | null {
  if (!node) {
    return null;
  }
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isLiteral(node) && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

const WEBSOCKET_HELPERS = new Set(['defineRoom', 'defineWebSocket']);

export function detectWebSocketDefinition(absPath: string): WebSocketSourceInfo | null {
  const code = readFileSync(absPath, 'utf-8');
  const definition = readResourceDefinition(absPath, code, WEBSOCKET_HELPERS);
  if (!definition) {
    return null;
  }
  const hasAuthGate =
    isObjectExpression(definition.options) &&
    (definition.options.properties ?? []).some(
      (property) =>
        property.type === 'Property' &&
        getPropertyName((property as AstProperty).key) === 'onBeforeConnect',
    );
  return {
    mode: definition.helper === 'defineRoom' ? 'room' : 'socket',
    hasAuthGate,
    ...(definition.name === undefined ? {} : { name: definition.name }),
  };
}

function buildWebSocketRoute(
  root: string,
  filePath: string,
  paths = readProjectPaths(root),
): WebSocketRouteDefinition {
  const parsed = parseWebSocketFilename(filePath);
  const info = detectWebSocketDefinition(join(paths.routesDir, filePath));
  const className =
    info?.name === undefined
      ? deriveWebSocketClassName(filePath)
      : deriveWebSocketClassNameFromName(info.name);

  return {
    ...parsed,
    className,
    bindingName: className,
    mode: info?.mode ?? 'socket',
    hasAuthGate: info?.hasAuthGate ?? false,
    ...(info?.name === undefined ? {} : { name: info.name }),
  };
}

function parseWebSocketFiles(
  root: string,
  files: Array<string>,
  paths = readProjectPaths(root),
  environment?: RouteEnvironment,
): Array<WebSocketRouteDefinition> {
  const routes = files
    .filter((f) => isWebSocketRouteFile(f))
    .filter((f) => !f.split('/').some((segment) => segment.startsWith('_')))
    .filter((filePath) =>
      isRouteEnabledForEnvironment(parseWebSocketFilename(filePath), environment),
    )
    .map((filePath) => buildWebSocketRoute(root, filePath, paths))
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) {
        return a.catchAll ? 1 : -1;
      }
      return a.pattern.localeCompare(b.pattern);
    });
  const byClass = new Map<string, Array<WebSocketRouteDefinition>>();
  for (const route of routes) {
    const previous = byClass.get(route.className) ?? [];
    if (
      previous.some((other) => other.env === null || route.env === null || other.env === route.env)
    ) {
      throw new Error(
        `websocket: duplicate generated name '${route.className}' for '${route.filePath}'. Choose a different resource name or rename one of the WebSocket route files.`,
      );
    }
    previous.push(route);
    byClass.set(route.className, previous);
  }
  return routes;
}

export function scanWebSocketRoutesSync(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
  environment?: RouteEnvironment,
): Array<WebSocketRouteDefinition> {
  const pattern = `**/*.{${HANDLER_EXTENSIONS.join(',')}}`;
  let files: Array<string>;
  try {
    files = globSync(pattern, { cwd: paths.routesDir, absolute: false });
  } catch {
    files = [];
  }
  return parseWebSocketFiles(root, files, paths, environment);
}

export function isWebSocketPatternFile(filePath: string): boolean {
  return isWebSocketRouteFile(filePath);
}
