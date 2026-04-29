import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob, globSync } from 'tinyglobby';
import { parseSync } from 'vite';
import {
  isCallExpression,
  isIdentifier,
  isLiteral,
  isObjectExpression,
  type AstExportDefaultDeclaration,
  type AstNode,
  type AstProgram,
  type AstProperty,
  type AstVariableDeclaration,
} from '../shared/ast.ts';
import { parseWebSocketFilename, type RouteDefinition } from './parse-filename.ts';

const HANDLER_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];
const WEBSOCKET_ROUTE_RE = /(?:\.(?:dev|prod))?\.ws\.(?:ts|mts|js|mjs)$/;

export interface WebSocketRouteDefinition extends RouteDefinition {
  className: string;
  bindingName: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
}

type WebSocketSourceInfo = {
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
};

function isWebSocketRouteFile(filePath: string): boolean {
  return WEBSOCKET_ROUTE_RE.test(filePath.replace(/\\/g, '/'));
}

function toIdentifierPart(segment: string): string {
  const normalized = segment
    .replace(/^\(\s*|\s*\)$/g, '')
    .replace(/^\[\.\.\.(.+)\]$/, '$1')
    .replace(/^\[(.+)\]$/, '$1')
    .replace(/\.ws$/, '')
    .replace(/\.(dev|prod)$/, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ');

  return normalized
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

export function deriveWebSocketClassName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\.(ts|mts|js|mjs)$/, '');
  const parts = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && !(segment.startsWith('(') && segment.endsWith(')')))
    .map(toIdentifierPart)
    .filter(Boolean);

  return (parts.length > 0 ? parts.join('') : 'WebSocket') + 'Ws';
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

function extractDefinition(call: AstNode | undefined): WebSocketSourceInfo | null {
  if (!isCallExpression(call)) {
    return null;
  }
  if (!isIdentifier(call.callee)) {
    return null;
  }

  const calleeName = call.callee.name;
  if (calleeName !== 'defineRoom' && calleeName !== 'defineWebSocket') {
    return null;
  }

  let hasAuthGate = false;
  const options = call.arguments?.[0];
  if (isObjectExpression(options)) {
    for (const property of options.properties ?? []) {
      if (property.type !== 'Property') {
        continue;
      }
      if (getPropertyName((property as AstProperty).key) === 'onBeforeConnect') {
        hasAuthGate = true;
        break;
      }
    }
  }

  return {
    mode: calleeName === 'defineRoom' ? 'room' : 'socket',
    hasAuthGate,
  };
}

export function detectWebSocketDefinition(absPath: string): WebSocketSourceInfo | null {
  const code = readFileSync(absPath, 'utf-8');
  const filename = absPath.split('/').pop() ?? absPath;
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return null;
  }

  const program = parsed.program as unknown as AstProgram;
  const variableInitializers = new Map<string, AstNode>();

  for (const node of program.body ?? []) {
    if (node.type === 'VariableDeclaration') {
      for (const declarator of (node as AstVariableDeclaration).declarations ?? []) {
        if (isIdentifier(declarator.id) && declarator.init) {
          variableInitializers.set(declarator.id.name, declarator.init);
        }
      }
    }
  }

  for (const node of program.body ?? []) {
    if (node.type !== 'ExportDefaultDeclaration') {
      continue;
    }
    const declaration = (node as AstExportDefaultDeclaration).declaration;
    if (isIdentifier(declaration)) {
      return extractDefinition(variableInitializers.get(declaration.name));
    }
    return extractDefinition(declaration);
  }

  return null;
}

function buildWebSocketRoute(root: string, filePath: string): WebSocketRouteDefinition {
  const parsed = parseWebSocketFilename(filePath);
  const info = detectWebSocketDefinition(join(root, 'routes', filePath));
  const className = deriveWebSocketClassName(filePath);

  return {
    ...parsed,
    className,
    bindingName: className,
    mode: info?.mode ?? 'socket',
    hasAuthGate: info?.hasAuthGate ?? false,
  };
}

function parseWebSocketFiles(root: string, files: Array<string>): Array<WebSocketRouteDefinition> {
  return files
    .filter((f) => isWebSocketRouteFile(f))
    .filter((f) => !f.split('/').some((segment) => segment.startsWith('_')))
    .map((filePath) => buildWebSocketRoute(root, filePath))
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) {
        return a.catchAll ? 1 : -1;
      }
      return a.pattern.localeCompare(b.pattern);
    });
}

export async function scanWebSocketRoutes(root: string): Promise<Array<WebSocketRouteDefinition>> {
  const pattern = `**/*.{${HANDLER_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: `${root}/routes`, absolute: false }).catch(
    () => [] as Array<string>,
  );
  return parseWebSocketFiles(root, files);
}

export function scanWebSocketRoutesSync(root: string): Array<WebSocketRouteDefinition> {
  const pattern = `**/*.{${HANDLER_EXTENSIONS.join(',')}}`;
  let files: Array<string>;
  try {
    files = globSync(pattern, { cwd: `${root}/routes`, absolute: false });
  } catch {
    files = [];
  }
  return parseWebSocketFiles(root, files);
}

export function isWebSocketPatternFile(filePath: string): boolean {
  return isWebSocketRouteFile(filePath);
}
