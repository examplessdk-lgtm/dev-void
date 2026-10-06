import { parse } from 'es-module-lexer/js';
import { walk } from 'estree-walker';
import { parseSync } from 'vite';
import { isIdentifier, isMemberExpression, type AstNode, type AstProgram } from '../shared/ast.ts';

export type InferredBindings = {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
  needsAuth: boolean;
  needsQueues: boolean;
  needsAI: boolean;
  needsSandbox: boolean;
  needsLive?: boolean;
  needsEmail?: boolean;
};

// SEND_EMAIL is intentionally absent from this regex: Void owns that binding
// (managed sends go through __VOID_PROXY/email/send; native Cloudflare deploys
// add SEND_EMAIL themselves), so the `void/email` import (tier 1 below) is the
// sole driver of `needsEmail`.
const ENV_BINDING_RE = /\benv\s*\.\s*(DB|KV|STORAGE|QUEUE_\w+|AI|SANDBOX)\b/;

/**
 * Infer which Cloudflare bindings a source file uses.
 *
 * Uses a tiered approach for performance:
 *   Tier 1: es-module-lexer to extract import sources (fast, asm.js, no init),
 *           with a TSX parser fallback when the lexer cannot parse JSX
 *   Tier 2: Regex check for env.DB/KV/STORAGE patterns
 *   Tier 3: Full AST walk only when regex matches (to confirm member expressions)
 */
export function inferBindingsFromSource(code: string, filename: string): InferredBindings {
  const result: InferredBindings = {
    needsD1: false,
    needsKV: false,
    needsR2: false,
    needsAuth: false,
    needsQueues: false,
    needsAI: false,
    needsSandbox: false,
    needsLive: false,
    needsEmail: false,
  };

  const moduleReferences: Array<{ source: string; statement: string }> = [];
  let parsedProgram: AstProgram | undefined;

  // Tier 1: Fast import detection via es-module-lexer
  try {
    const [imports] = parse(code);
    for (const imp of imports) {
      if (imp.specifier) {
        moduleReferences.push({
          source: imp.specifier,
          statement: code.slice(imp.importStart, imp.importEnd + 1),
        });
      }
    }
  } catch {
    // JSX/TSX is not accepted by es-module-lexer. Parse it once instead of
    // scanning across unrelated import statements with a multiline regex.
    try {
      parsedProgram = parseSync(filename, code).program as unknown as AstProgram;
      for (const node of parsedProgram.body as Array<{
        type: string;
        start: number;
        end: number;
        source?: { value?: unknown };
      }>) {
        if (
          (node.type === 'ImportDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration') &&
          typeof node.source?.value === 'string'
        ) {
          moduleReferences.push({
            source: node.source.value,
            statement: code.slice(node.start, node.end),
          });
        }
      }
    } catch {
      // Invalid source cannot be safely inferred from import text alone.
    }
  }

  for (const { source, statement } of moduleReferences) {
    if (isTypeOnlyModuleStatement(statement)) {
      continue;
    }
    switch (source) {
      case 'void/db':
        result.needsD1 = true;
        break;
      case 'void/kv':
        result.needsKV = true;
        break;
      case 'void/storage':
        result.needsR2 = true;
        break;
      case 'void/auth':
        result.needsAuth = true;
        break;
      case 'void/queues':
        result.needsQueues = true;
        break;
      case 'void/ai':
        result.needsAI = true;
        break;
      case 'void/sandbox':
        result.needsSandbox = true;
        break;
      case 'void/email':
        result.needsEmail = true;
        break;
      case 'void/live':
        result.needsLive = true;
        break;
      case 'void/client':
      case 'void/client/react':
      case 'void/client/vue':
      case 'void/client/svelte':
      case 'void/client/solid': {
        // Check if the `auth` specifier is imported (not just `fetch`)
        if (/\bauth\b/.test(statement)) {
          result.needsAuth = true;
        }
        break;
      }
    }
  }

  // If imports resolved every binding the AST tier could still discover, we're
  // done. `needsEmail` is deliberately not part of this predicate: it has no
  // env-binding form (see ENV_BINDING_RE above), so it is already final here
  // and requiring it would only suppress an otherwise-valid early exit.
  if (
    result.needsD1 &&
    result.needsKV &&
    result.needsR2 &&
    result.needsAI &&
    result.needsSandbox &&
    result.needsLive
  ) {
    return result;
  }

  // Tier 2: Regex check for env.DB/KV/STORAGE
  if (!ENV_BINDING_RE.test(code)) {
    return result;
  }

  // Tier 3: Full AST walk to confirm member expressions
  let program = parsedProgram;
  if (!program) {
    try {
      program = parseSync(filename, code).program as unknown as AstProgram;
    } catch {
      return result;
    }
  }

  walk(program as unknown as Parameters<typeof walk>[0], {
    enter(node) {
      const current = node as AstNode;
      if (!isMemberExpression(current)) {
        return;
      }
      if (current.computed) {
        return;
      }

      const property = current.property;
      if (!isIdentifier(property)) {
        return;
      }

      // Check if the object is *.env (i.e., a MemberExpression with .env)
      const obj = current.object;
      const isViaContextEnv =
        isMemberExpression(obj) && isIdentifier(obj.property) && obj.property.name === 'env';
      const isDirectEnv = isIdentifier(obj) && obj.name === 'env';
      if (!isViaContextEnv && !isDirectEnv) {
        return;
      }

      switch (property.name) {
        case 'DB':
          result.needsD1 = true;
          break;
        case 'KV':
          result.needsKV = true;
          break;
        case 'STORAGE':
          result.needsR2 = true;
          break;
        case 'AI':
          result.needsAI = true;
          break;
        case 'SANDBOX':
          result.needsSandbox = true;
          break;
        default:
          if (property.name.startsWith('QUEUE_')) {
            result.needsQueues = true;
          }
          break;
      }
    },
  });

  return result;
}

function isTypeOnlyModuleStatement(statement: string): boolean {
  if (/^\s*(?:import|export)\s+type\b/.test(statement)) {
    return true;
  }

  const specifierStart = statement.indexOf('{');
  const specifierEnd = statement.lastIndexOf('}');
  if (specifierStart === -1 || specifierEnd === -1 || specifierEnd < specifierStart) {
    return false;
  }

  const beforeSpecifiers = statement.slice(0, specifierStart);
  if (!/^\s*(?:import|export)\s*$/.test(beforeSpecifiers)) {
    return false;
  }

  const specifiers = statement
    .slice(specifierStart + 1, specifierEnd)
    .split(',')
    .map((specifier) => specifier.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith('type '));
}

/**
 * Merge multiple InferredBindings into a single result (union).
 */
export function mergeBindings(bindings: Array<InferredBindings>): InferredBindings {
  return {
    needsD1: bindings.some((b) => b.needsD1),
    needsKV: bindings.some((b) => b.needsKV),
    needsR2: bindings.some((b) => b.needsR2),
    needsAuth: bindings.some((b) => b.needsAuth),
    needsQueues: bindings.some((b) => b.needsQueues),
    needsAI: bindings.some((b) => b.needsAI),
    needsSandbox: bindings.some((b) => b.needsSandbox),
    needsLive: bindings.some((b) => b.needsLive),
    needsEmail: bindings.some((b) => b.needsEmail),
  };
}
