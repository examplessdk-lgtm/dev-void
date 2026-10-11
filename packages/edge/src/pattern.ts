/**
 * Path-pattern matchers shared by routing, header, and revalidate rules.
 *
 * `compilePattern` syntax:
 *   `:name`   — single path segment, captured as `name`
 *   `:name*`  — zero or more path segments, captured as `name`
 *   `*`       — zero or more path segments, captured as `splat` (legacy)
 *
 * When a legacy pattern contains multiple anonymous `*`, the first captures
 * as `splat` and later wildcards are non-capturing.
 */

const MAX_CACHE = 256;

export type CompiledPattern = Readonly<{
  regex: RegExp;
  paramNames: ReadonlyArray<string>;
}>;

const compileCache = new Map<string, CompiledPattern>();

const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/;
const PARAM_CHAR = /[A-Za-z0-9_]/;

/** LRU read: re-inserting a hit moves it to the most-recently-used end of Map order. */
function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write: evict the least-recently-used entry once the cache is full. */
function lruSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next();
    if (!first.done) {
      cache.delete(first.value);
    }
  }
  cache.set(key, value);
}

export function compilePattern(source: string): CompiledPattern {
  const cached = lruGet(compileCache, source);
  if (cached) {
    return cached;
  }

  const paramNames: Array<string> = [];
  let legacySplatCaptured = false;
  let pattern = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === ':') {
      let nameEnd = index + 1;
      while (nameEnd < source.length && PARAM_CHAR.test(source[nameEnd]!)) {
        nameEnd++;
      }
      const name = source.slice(index + 1, nameEnd);
      if (!name) {
        pattern += '\\:';
        index++;
        continue;
      }
      paramNames.push(name);
      if (source[nameEnd] === '*') {
        pattern += `(?<${name}>.*)`;
        index = nameEnd + 1;
      } else {
        pattern += `(?<${name}>[^/]+)`;
        index = nameEnd;
      }
    } else if (character === '*') {
      if (legacySplatCaptured) {
        pattern += `.*`;
      } else {
        paramNames.push('splat');
        pattern += `(?<splat>.*)`;
        legacySplatCaptured = true;
      }
      index++;
    } else {
      if (REGEX_SPECIAL.test(character)) {
        pattern += '\\';
      }
      pattern += character;
      index++;
    }
  }

  const compiled: CompiledPattern = { regex: new RegExp(`^${pattern}$`), paramNames };
  lruSet(compileCache, source, compiled);
  return compiled;
}

/**
 * Match a pattern against a pathname. Returns captured params, or null.
 * A malformed pattern (e.g. a repeated name like `/:splat/*`) also returns
 * null, so one bad rule cannot fail unrelated requests.
 */
export function matchPatternCaptures(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  let compiled: CompiledPattern;
  try {
    compiled = compilePattern(pattern);
  } catch {
    return null;
  }
  const match = compiled.regex.exec(pathname);
  if (!match) {
    return null;
  }
  return match.groups ?? {};
}

/**
 * Match a pattern against a pathname (boolean form). Malformed patterns yield
 * `false` rather than throwing (see `matchPatternCaptures`).
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  try {
    return compilePattern(pattern).regex.test(pathname);
  } catch {
    return false;
  }
}

const literalRegexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname using LITERAL semantics — no named
 * captures. Only `*` is special (matches any characters including `/`); every
 * other character (including `:`) is treated as a literal.
 *
 * Used for header rules and `routing.revalidateQueryAllowlist` keys, which
 * never had `:name` capture syntax; existing tenant configs may include literal
 * `:` (e.g. `/api/v1:health`, `:batchGet`-style URLs). Routing rules
 * (`redirects`/`rewrites`/`fallbacks`) use the capture-aware `compilePattern`.
 */
export function matchLiteralPattern(pattern: string, pathname: string): boolean {
  let regex = lruGet(literalRegexCache, pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    regex = new RegExp(`^${escaped}$`);
    lruSet(literalRegexCache, pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    // V8 compiles on first use and throws for very large patterns.
    return false;
  }
}

const segmentRegexCache = new Map<string, RegExp>();

/**
 * Match a `routing.revalidate` key or page pattern against a pathname. Like
 * `matchLiteralPattern`, except for whole-segment params:
 *   `:name`      — exactly one non-empty path segment (any non-`/` name)
 *   `:name{.+}`  — one or more characters that may cross `/`
 * A mid-segment `:` (`/api/v1:health`) stays literal, and any other `{...}`
 * constraint keeps the single-segment meaning. Uses its own regex cache because
 * the same source compiles differently here.
 */
export function matchSegmentPattern(pattern: string, pathname: string): boolean {
  let regex = lruGet(segmentRegexCache, pattern);
  if (!regex) {
    // Private-use sentinels survive the escape step. `:name{.+}` is replaced
    // first so the plain `:name` rule cannot strand its `{.+}`.
    const escaped = pattern
      .replace(/(^|\/):[^/{}]+\{\.\+\}(?=\/|$)/g, '$1\uE001') // named catch-all :name{.+} -> catch-all sentinel
      .replace(/(^|\/):[^/]+(?=\/|$)/g, '$1\uE000') // whole-segment :name -> segment sentinel
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
      .replaceAll('*', '.*') // legacy `*` crosses '/'
      .replaceAll('\uE000', '[^/]+') // segment sentinel -> one segment
      .replaceAll('\uE001', '.+'); // catch-all sentinel -> >=1 char, crosses '/'
    regex = new RegExp(`^${escaped}$`);
    lruSet(segmentRegexCache, pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    // V8 compiles on first use and throws for very large patterns.
    return false;
  }
}

/**
 * Substitute `:name` and `:name*` tokens in a destination string with the
 * matching named captures from `params`. `:splat` works for legacy `*` patterns
 * because `compilePattern` captures anonymous `*` as `splat`.
 */
export function substituteParams(destination: string, params: Record<string, string>): string {
  const result = destination.replace(/:([A-Za-z0-9_]+)\*?/g, (whole, name: string) => {
    return params[name] ?? whole;
  });
  // A capture can start with '/', so a path destination must stay on this site.
  if (/^[/\\]{2}/.test(result) && !/^[/\\]{2}/.test(destination)) {
    return '/' + result.replace(/^[/\\]+/, '');
  }
  return result;
}
