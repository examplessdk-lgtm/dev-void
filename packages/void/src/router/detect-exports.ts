import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseSync } from 'vite';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

/**
 * Detect which HTTP method names are exported from a route file.
 * Scans top-level named exports for identifiers matching HTTP methods.
 */
export function detectHttpExports(absPath: string): string[] {
  const code = readFileSync(absPath, 'utf-8');
  const filename = basename(absPath);
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return [];
  }

  const methods: string[] = [];
  for (const node of parsed.program.body as any[]) {
    if (node.type === 'ExportNamedDeclaration') {
      // export const GET = ...; export function POST() { ... }
      const decl = node.declaration;
      if (decl) {
        if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            if (declarator.id?.type === 'Identifier' && HTTP_METHODS.has(declarator.id.name)) {
              methods.push(declarator.id.name);
            }
          }
        } else if (decl.type === 'FunctionDeclaration' && decl.id?.type === 'Identifier') {
          if (HTTP_METHODS.has(decl.id.name)) {
            methods.push(decl.id.name);
          }
        }
      }
      // export { GET, POST } (specifiers)
      if (node.specifiers) {
        for (const spec of node.specifiers) {
          const exported = spec.exported?.name ?? spec.local?.name;
          if (exported && HTTP_METHODS.has(exported)) {
            methods.push(exported);
          }
        }
      }
    }
  }

  return methods;
}
