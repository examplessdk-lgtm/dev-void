import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'pathslash';
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

const SSR_SERVER_ENTRY_NAMES = ['main.ssr.ts', 'main.ssr.tsx'] as const;
const SSR_CLIENT_ENTRY_NAMES = ['main.client.ts', 'main.client.tsx'] as const;

export const SSR_SERVER_ENTRY_RELATIVE_PATHS: Array<string> = SSR_SERVER_ENTRY_NAMES.map(
  (name) => `src/${name}`,
);
export const SSR_CLIENT_ENTRY_RELATIVE_PATHS: Array<string> = SSR_CLIENT_ENTRY_NAMES.map(
  (name) => `src/${name}`,
);

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
      relativePath: relative(root, join(paths.ssrDir, entryName)),
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
  if (!client) {
    throw new Error(
      `ssr: Missing client entry. Add one of: ${SSR_CLIENT_ENTRY_RELATIVE_PATHS.join(', ')}.`,
    );
  }
  if (!server) {
    throw new Error(
      `ssr: Missing server entry. Add one of: ${SSR_SERVER_ENTRY_RELATIVE_PATHS.join(', ')}.`,
    );
  }

  validateServerRenderExport(server);
  return { server, client };
}

export function validateSsrEntry(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  return validateSsrEntries(root, paths)?.server.absolutePath ?? null;
}
