import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'pathe';
import { parseSync } from 'vite';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import {
  isIdentifier,
  type AstCallExpression,
  type AstExportDefaultDeclaration,
  type AstExportNamedDeclaration,
  type AstExportSpecifier,
  type AstFunctionDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
  type AstVariableDeclarator,
} from '../shared/ast.ts';

export const SSR_SERVER_ENTRY_RELATIVE_PATHS = ['src/main.ssr.ts', 'src/main.ssr.tsx'] as const;
export const SSR_CLIENT_ENTRY_RELATIVE_PATHS = [
  'src/main.client.ts',
  'src/main.client.tsx',
] as const;

type ResolvedEntry = {
  absolutePath: string;
  relativePath: string;
};

export type SsrEntries = {
  server: ResolvedEntry;
  client: ResolvedEntry;
};

function resolveSingleEntry(
  root: string,
  entries: ReadonlyArray<string>,
  label: string,
  paths: ProjectPaths = readProjectPaths(root),
): ResolvedEntry | null {
  const matches = entries
    .map((entryName) => ({
      relativePath: relative(root, join(paths.ssrDir, entryName)).replace(/\\/g, '/'),
      absolutePath: join(paths.ssrDir, entryName),
    }))
    .filter((entry) => existsSync(entry.absolutePath));

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const names = matches.map((entry) => entry.relativePath).join(', ');
    throw new Error(`ssr: Multiple ${label} entry files found: ${names}. Keep only one.`);
  }
  return matches[0];
}

const SSR_SERVER_ENTRY_NAMES = ['main.ssr.ts', 'main.ssr.tsx'] as const;
const SSR_CLIENT_ENTRY_NAMES = ['main.client.ts', 'main.client.tsx'] as const;

export function getSsrServerEntryPath(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  const entry = resolveSingleEntry(root, SSR_SERVER_ENTRY_NAMES, 'SSR', paths);
  return entry?.absolutePath ?? null;
}

export function hasSsrEntry(root: string, paths: ProjectPaths = readProjectPaths(root)): boolean {
  return getSsrServerEntryPath(root, paths) !== null;
}

function validateServerRenderExport(entry: ResolvedEntry): void {
  const { absolutePath, relativePath } = entry;

  const source = readFileSync(absolutePath, 'utf-8');
  if (
    /\bexport\s+(?:async\s+)?function\s+render\b/.test(source) ||
    /\bexport\s+const\s+render\b/.test(source) ||
    /\bexport\s+default\s+(?:defineRender\b|(?:async\s+)?function\b)/.test(source)
  ) {
    return;
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(relativePath, source);
  } catch (err) {
    throw new Error(
      `ssr: Invalid entry '${relativePath}'. Could not parse source: '${err instanceof Error ? err.message : String(err)}'.`,
    );
  }

  const program = parsed.program as unknown as AstProgram;
  const body = program.body ?? [];

  const hasRenderExport = body.some((node: AstNode) => {
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = (node as AstExportDefaultDeclaration).declaration;
      if (
        declaration?.type === 'FunctionDeclaration' ||
        declaration?.type === 'FunctionExpression' ||
        declaration?.type === 'ArrowFunctionExpression'
      ) {
        return true;
      }
      if (declaration?.type === 'CallExpression') {
        const call = declaration as AstCallExpression;
        return isIdentifier(call.callee) && call.callee.name === 'defineRender';
      }
      return false;
    }
    if (node.type !== 'ExportNamedDeclaration') {
      return false;
    }
    // `export type { render }` exports no runtime value.
    if ((node as AstExportNamedDeclaration).exportKind === 'type') {
      return false;
    }

    const declaration = (node as AstExportNamedDeclaration).declaration;
    if (declaration?.type === 'FunctionDeclaration') {
      const fn = declaration as AstFunctionDeclaration;
      return isIdentifier(fn.id) && fn.id.name === 'render';
    }
    if (declaration?.type === 'VariableDeclaration') {
      return ((declaration as AstVariableDeclaration).declarations ?? []).some(
        (decl: AstVariableDeclarator) => isIdentifier(decl.id) && decl.id.name === 'render',
      );
    }

    const specifiers = (node as AstExportNamedDeclaration).specifiers ?? [];
    return specifiers.some((specifier: AstExportSpecifier) => {
      if (specifier.exportKind === 'type') {
        return false;
      }
      const exported = specifier.exported;
      return isIdentifier(exported) && exported.name === 'render';
    });
  });

  if (!hasRenderExport) {
    throw new Error(
      `ssr: Invalid entry '${relativePath}'. Export \`render(c, assetTags)\` or \`export default defineRender(...)\`.`,
    );
  }
}

/**
 * Validate SSR mode entry conventions.
 * Returns null when SSR mode is not used.
 */
export function validateSsrEntries(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): SsrEntries | null {
  const server = resolveSingleEntry(root, SSR_SERVER_ENTRY_NAMES, 'SSR', paths);
  const client = resolveSingleEntry(root, SSR_CLIENT_ENTRY_NAMES, 'SSR client', paths);

  if (!server && !client) {
    return null;
  }
  if (server && !client) {
    throw new Error(
      `ssr: Missing client entry. Add one of: ${SSR_CLIENT_ENTRY_RELATIVE_PATHS.join(', ')}.`,
    );
  }
  if (!server && client) {
    throw new Error(
      `ssr: Missing server entry. Add one of: ${SSR_SERVER_ENTRY_RELATIVE_PATHS.join(', ')}.`,
    );
  }

  validateServerRenderExport(server!);
  return {
    server: server!,
    client: client!,
  };
}

export function validateSsrEntry(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  return validateSsrEntries(root, paths)?.server.absolutePath ?? null;
}
