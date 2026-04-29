/**
 * `void init` hook — when the project has no `env.ts` but has dotenv files
 * on disk, scaffold an `env.ts` whose keys mirror what the user already
 * has. Inference is intentionally permissive: we only upgrade from the
 * default `string()` helper when the value is unambiguously a boolean,
 * URL, or small integer. Everything else stays a string and carries a
 * one-line banner nudging the user to tighten the schema.
 *
 * This is a best-effort DX sweetener, not a correctness boundary — a
 * wrong guess only costs the user a single-line edit.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandDotenv, parseDotenvFile as sharedParseDotenvFile } from '../shared/dotenv.ts';

/** Dotenv files we harvest keys from, in trust order (first wins per key). */
export const SCAFFOLD_SOURCE_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.example',
] as const;

export type InferredHelper = 'string' | 'number' | 'boolean' | 'url';

export interface InferredEntry {
  key: string;
  helper: InferredHelper;
  /** First non-empty value seen for this key, if any (used for diagnostics only). */
  sampleValue?: string;
}

const BOOLEAN_LITERAL = /^(true|false)$/i;
const HTTP_URL = /^https?:\/\/\S+$/;
// Plain integer, reasonable port/size range, no leading zero unless value is 0.
// Deliberately strict: phone numbers, Stripe IDs, and timestamps all look
// numeric but users read them as strings.
const SMALL_INTEGER = /^(?:0|[1-9]\d{0,4})$/;

/**
 * Classify a single `.env` value into the Void built-in helper to use.
 * Returns `'string'` whenever inference is ambiguous — the comment in the
 * scaffolded file asks the user to tighten any wrong guesses.
 */
export function inferHelperForValue(value: string | undefined): InferredHelper {
  if (!value) {
    return 'string';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'string';
  }
  if (BOOLEAN_LITERAL.test(trimmed)) {
    return 'boolean';
  }
  if (HTTP_URL.test(trimmed)) {
    return 'url';
  }
  if (SMALL_INTEGER.test(trimmed)) {
    return 'number';
  }
  return 'string';
}

/**
 * Thin re-export of the shared dotenv parser. Kept as a named export so the
 * unit test surface (`parseDotenvFile`) is unchanged from when this module
 * carried its own copy.
 */
export function parseDotenvFile(filePath: string): Record<string, string> {
  return sharedParseDotenvFile(filePath);
}

/** Collect a deduped list of inferred entries from the dotenv files we find. */
export function collectInferredEntries(root: string): Array<InferredEntry> {
  const seen = new Map<string, InferredEntry>();
  // Walk files in trust order (first wins). At each step we expand the
  // current file's values against the cumulative "earliest-wins" record so
  // that a value like `API_URL=${BASE_URL}/v1` resolves even when
  // `BASE_URL` lives in a previously-seen file. A per-file expanded view is
  // what feeds type inference, so an unresolved literal isn't mis-classified
  // as a plain string when it would have been a URL after expansion.
  const cumulative: Record<string, string> = {};
  for (const file of SCAFFOLD_SOURCE_FILES) {
    const parsed = sharedParseDotenvFile(join(root, file), { expand: false });
    // Build an expansion view: cumulative entries overlaid with this file's
    // raw values (earlier files win for already-seen keys, but this file's
    // new keys are still available as expansion targets).
    const expansionView: Record<string, string> = { ...parsed, ...cumulative };
    const expanded = expandDotenv(expansionView);
    for (const key of Object.keys(parsed)) {
      const value = expanded[key] ?? '';
      // Lock in cumulative with earliest-wins semantics.
      if (!(key in cumulative)) {
        cumulative[key] = parsed[key]!;
      }
      const existing = seen.get(key);
      // First file to mention the key wins for the sample value, but a
      // later file with a non-empty value can still upgrade inference if
      // the earlier value was empty (e.g. `.env.example` had `FOO=` and
      // `.env.local` has `FOO=3000`).
      if (!existing) {
        seen.set(key, {
          key,
          helper: inferHelperForValue(value),
          sampleValue: value || undefined,
        });
      } else if (!existing.sampleValue && value) {
        seen.set(key, {
          key,
          helper: inferHelperForValue(value),
          sampleValue: value,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Render the scaffolded `env.ts` body. The imports are pulled in lazily
 * so only helpers we reference appear in the import statement.
 */
export function renderEnvTs(entries: Array<InferredEntry>): string {
  if (entries.length === 0) {
    return [
      `import { defineEnv } from 'void/env';`,
      ``,
      `// Define your environment variables here. See https://voidzero.dev/guide/env-vars`,
      `export default defineEnv({});`,
      ``,
    ].join('\n');
  }

  const helpers = new Set<InferredHelper>(['string']);
  for (const e of entries) {
    helpers.add(e.helper);
  }
  const importList = (['string', 'number', 'boolean', 'url'] as const).filter((h) =>
    helpers.has(h),
  );

  const lines: Array<string> = [];
  lines.push(`import { defineEnv, ${importList.join(', ')} } from 'void/env';`);
  lines.push('');
  lines.push(`// Scaffolded from your .env files. Inference is conservative — review each`);
  lines.push(`// entry and tighten types as needed (e.g. oneOf([...]), url(), .optional(),`);
  lines.push(`// .default(value), or a Standard Schema validator from valibot/zod/arktype).`);
  lines.push(`export default defineEnv({`);
  for (const entry of entries) {
    lines.push(`  ${entry.key}: ${entry.helper}(),`);
  }
  lines.push(`});`);
  lines.push('');
  return lines.join('\n');
}

export interface ScaffoldResult {
  /** Path written (absolute), or `null` if nothing was written. */
  written: string | null;
  /** Reason we skipped, when `written` is null. */
  skipReason?: 'env-ts-exists' | 'no-dotenv-files';
  entries: Array<InferredEntry>;
}

/**
 * If the project has no `env.ts`, scaffold one based on `.env*` files the
 * user already has. Safe to call unconditionally during `void init` — it
 * no-ops when `env.ts` is present. Never overwrites an existing file.
 */
export function maybeScaffoldEnvTs(root: string): ScaffoldResult {
  const envTsCandidates = ['env.ts', 'env.mts', 'env.js', 'env.mjs'];
  for (const candidate of envTsCandidates) {
    if (existsSync(join(root, candidate))) {
      return { written: null, skipReason: 'env-ts-exists', entries: [] };
    }
  }
  // Same for `src/env.*` — respect whichever location the user already uses.
  for (const candidate of ['src/env.ts', 'src/env.mts', 'src/env.js', 'src/env.mjs']) {
    if (existsSync(join(root, candidate))) {
      return { written: null, skipReason: 'env-ts-exists', entries: [] };
    }
  }

  const hasAnyDotenv = SCAFFOLD_SOURCE_FILES.some((f) => existsSync(join(root, f)));
  if (!hasAnyDotenv) {
    return { written: null, skipReason: 'no-dotenv-files', entries: [] };
  }

  const entries = collectInferredEntries(root);
  const target = join(root, 'env.ts');
  writeFileSync(target, renderEnvTs(entries));
  return { written: target, entries };
}
