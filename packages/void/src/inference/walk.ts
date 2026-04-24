import { parse } from 'es-module-lexer/js';
import { walk } from 'estree-walker';
import { parseSync } from 'vite';
import { isIdentifier, isMemberExpression, type AstNode, type AstProgram } from '../shared/ast';

export interface InferredBindings {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
  needsAuth: boolean;
  needsQueues: boolean;
  needsAI: boolean;
  needsSandbox: boolean;
}

const ENV_BINDING_RE = /\benv\s*\.\s*(DB|KV|STORAGE|QUEUE_\w+|AI|SANDBOX)\b/;

/**
 * Infer which Cloudflare bindings a source file uses.
 *
 * Uses a tiered approach for performance:
 *   Tier 1: es-module-lexer to extract import sources (fast, asm.js, no init)
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
  };

  // Tier 1: Fast import detection via es-module-lexer
  try {
    const [imports] = parse(code);
    for (const imp of imports) {
      const source = imp.n;
      if (!source) {
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
        case 'void/queue':
          result.needsQueues = true;
          break;
        case 'void/ai':
          result.needsAI = true;
          break;
        case 'void/sandbox':
          result.needsSandbox = true;
          break;
        case 'void/client': {
          // Check if the `auth` specifier is imported (not just `fetch`)
          const stmt = code.slice(imp.ss, imp.se + 1);
          if (/\bauth\b/.test(stmt)) {
            result.needsAuth = true;
          }
          break;
        }
      }
    }
  } catch {
    // es-module-lexer can't parse JSX/TSX — fall back to regex for void/* imports
    if (/\bfrom\s+["']void\/db["']/.test(code)) {
      result.needsD1 = true;
    }
    if (/\bfrom\s+["']void\/kv["']/.test(code)) {
      result.needsKV = true;
    }
    if (/\bfrom\s+["']void\/storage["']/.test(code)) {
      result.needsR2 = true;
    }
    if (/\bfrom\s+["']void\/auth["']/.test(code)) {
      result.needsAuth = true;
    }
    if (/\bfrom\s+["']void\/queue["']/.test(code)) {
      result.needsQueues = true;
    }
    if (/\bfrom\s+["']void\/ai["']/.test(code)) {
      result.needsAI = true;
    }
    if (/\bfrom\s+["']void\/sandbox["']/.test(code)) {
      result.needsSandbox = true;
    }
    if (/\bfrom\s+["']void\/client["']/.test(code) && /\bauth\b/.test(code)) {
      result.needsAuth = true;
    }
  }

  // If imports resolved all bindings, we're done
  if (result.needsD1 && result.needsKV && result.needsR2 && result.needsAI && result.needsSandbox) {
    return result;
  }

  // Tier 2: Regex check for env.DB/KV/STORAGE
  if (!ENV_BINDING_RE.test(code)) {
    return result;
  }

  // Tier 3: Full AST walk to confirm member expressions
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return result;
  }

  const program = parsed.program as unknown as AstProgram;

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
  };
}
