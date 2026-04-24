/**
 * Shared dotenv parser + variable expander used by every CLI path that reads
 * `.env*` files (`void env check`, `void deploy`, `void init` scaffold
 * inference). A single source of truth avoids the drift we hit when two
 * hand-rolled parsers diverged on quoting / expansion semantics.
 *
 * Expansion supports `${VAR}` and `$VAR`, a `\$VAR` literal-escape, and
 * transitive references across earlier entries in the same record. Cycles
 * are detected and fall through to the raw literal rather than looping.
 *
 * Security note: expansion is deliberately scoped to the in-file record.
 * We do NOT consult `process.env` the way `dotenv-expand` does — a shell
 * env leaking into an `.env.example` via expansion would silently reveal
 * developer machine state in committed output, and `void env check` /
 * `void deploy` would then pass with values that aren't present in CI.
 *
 * The runtime path (Vite's own `loadEnv`) DOES consult `process.env` for
 * expansion. That's a deliberate Vite choice; `filterLoadedEnv` strips
 * shell pollution from the final worker vars so the two sides agree on
 * the observable surface even when expansion sources differ.
 *
 * This module is a leaf — it must not import from `../log` or any non-leaf
 * module so that the prerender subprocess's worker bundle doesn't pick up
 * unwanted transitive dependencies. Warnings are surfaced through the
 * `onWarn` callback and left for the caller to route.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Valid dotenv key — ASCII letter/underscore followed by letters/digits/underscore. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParseDotenvOptions {
  /** When true, run `${VAR}` / `$VAR` expansion after parsing. Default: true. */
  expand?: boolean;
  /**
   * When true (default), silently skip lines whose key doesn't match the
   * standard dotenv key regex. Set to false to throw instead — used by
   * `void secret sync` where a malformed key should be a hard error.
   */
  skipInvalidKeys?: boolean;
  /** Callback for expansion warnings (cycles). Caller routes to `voidWarn`. */
  onWarn?: (message: string) => void;
}

export interface ParseDotenvLineResult {
  key: string;
  value: string;
}

/**
 * Parse a single `KEY=VALUE` line into `{ key, value }`, stripping matching
 * single/double quotes around the value. Returns `null` for blanks, comments,
 * and non-assignment lines.
 */
export function parseDotenvLine(line: string): ParseDotenvLineResult | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const eq = trimmed.indexOf('=');
  if (eq === -1) {
    return null;
  }
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/**
 * Parse the raw contents of a dotenv file into a record, optionally
 * expanding `${VAR}` / `$VAR` references against earlier entries.
 */
export function parseDotenv(
  content: string,
  options: ParseDotenvOptions = {},
): Record<string, string> {
  const { expand: shouldExpand = true, skipInvalidKeys = true, onWarn } = options;
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const parsed = parseDotenvLine(line);
    if (!parsed) {
      continue;
    }
    if (!VALID_KEY.test(parsed.key)) {
      if (skipInvalidKeys) {
        continue;
      }
      throw new Error(`dotenv: Invalid key '${parsed.key}'.`);
    }
    env[parsed.key] = parsed.value;
  }
  return shouldExpand ? expandDotenv(env, { onWarn }) : env;
}

/**
 * Read and parse a dotenv file. Returns `{}` when the file is missing so
 * callers can treat "no file" and "empty file" identically.
 */
export function parseDotenvFile(
  filePath: string,
  options: ParseDotenvOptions = {},
): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseDotenv(readFileSync(filePath, 'utf-8'), options);
}

/**
 * Expand `${VAR}` / `$VAR` references in every value of a record against
 * the other entries in that same record. Matches the surface of
 * `dotenv-expand` minus the `process.env` fallback.
 *
 * Semantics:
 *   - `${VAR}` and `$VAR` both resolve (bare form stops at the first
 *     non-identifier character).
 *   - `\$VAR` stays literal; the backslash is consumed.
 *   - Nested refs resolve transitively — `A=${B}`, `B=${C}`, `C=v` → `A=v`.
 *   - Cycles are detected; the offending value keeps its raw literal and
 *     `onWarn` fires once per cycle seen.
 *   - Missing refs expand to the empty string, matching dotenv-expand.
 *
 * The input record is not mutated; a fresh object is returned.
 */
export function expandDotenv(
  input: Record<string, string>,
  options: { onWarn?: (message: string) => void } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const resolving = new Set<string>();
  const warned = new Set<string>();

  function resolveKey(key: string): string {
    if (!(key in input)) {
      return '';
    }
    if (key in out) {
      return out[key]!;
    }
    if (resolving.has(key)) {
      if (!warned.has(key) && options.onWarn) {
        warned.add(key);
        options.onWarn(`dotenv expansion cycle detected at "${key}" — leaving raw value in place`);
      }
      // Return the raw literal so the cycle short-circuits instead of
      // looping; callers see the un-expanded `${...}` text.
      return input[key]!;
    }
    resolving.add(key);
    const expanded = expandValue(input[key]!, resolveKey);
    resolving.delete(key);
    out[key] = expanded;
    return expanded;
  }

  for (const key of Object.keys(input)) {
    resolveKey(key);
  }
  return out;
}

/**
 * Expand a single value string. `resolve` returns the fully-expanded value
 * for a referenced key (or `''` when missing). Backslash-escapes (`\$VAR`,
 * `\${VAR}`) keep the `$...` literal and consume the backslash.
 */
function expandValue(value: string, resolve: (key: string) => string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '\\' && i + 1 < value.length && value[i + 1] === '$') {
      // Literal `$`: consume the backslash and emit `$`.
      result += '$';
      i += 2;
      continue;
    }
    if (ch !== '$') {
      result += ch;
      i++;
      continue;
    }
    // `$` — peek at the next char.
    const next = value[i + 1];
    if (next === '{') {
      const end = value.indexOf('}', i + 2);
      if (end === -1) {
        // Unterminated `${...` — treat as literal.
        result += ch;
        i++;
        continue;
      }
      const key = value.slice(i + 2, end);
      if (VALID_KEY.test(key)) {
        result += resolve(key);
      } else {
        // Non-identifier inside braces → literal.
        result += value.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    if (next && /[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < value.length && /[A-Za-z0-9_]/.test(value[j]!)) {
        j++;
      }
      const key = value.slice(i + 1, j);
      result += resolve(key);
      i = j;
      continue;
    }
    // `$` followed by nothing consumable → literal.
    result += ch;
    i++;
  }
  return result;
}

/**
 * Merge multiple parsed dotenv records with later-entries-win semantics,
 * then expand across the combined set. This is the recommended path for
 * callers reading multiple `.env*` files (Vite-style precedence), since
 * expansion sees every earlier file's keys at once.
 */
export function mergeAndExpand(
  records: Array<Record<string, string>>,
  options: { onWarn?: (message: string) => void } = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const record of records) {
    Object.assign(merged, record);
  }
  return expandDotenv(merged, options);
}
