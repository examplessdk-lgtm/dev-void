/**
 * Shared path-pattern compiler used by header rules and routing rules.
 *
 * Syntax:
 *   `:name`   — single path segment, captured as `name`
 *   `:name*`  — zero or more path segments, captured as `name`
 *   `*`       — zero or more path segments, captured as `splat` (legacy)
 *
 * When a legacy pattern contains multiple anonymous `*`, the first captures
 * as `splat` and later wildcards are non-capturing. Boolean matching remains
 * backward compatible for existing header/revalidate patterns.
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
 *
 * Returns null (rather than throwing) when the pattern itself is malformed —
 * e.g. multiple `*` producing duplicate `splat` capture names. Framework and
 * API ingest both reject those, but a hand-crafted manifest could still reach
 * the edge, and a single bad rule shouldn't 500 unrelated traffic.
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
    try {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
      regex = new RegExp(`^${escaped}$`);
    } catch {
      return false;
    }
    lruSet(literalRegexCache, pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    return false;
  }
}

const segmentRegexCache = new Map<string, RegExp>();

/**
 * Match a REVALIDATE ROUTE pattern against a pathname using SEGMENT-ANCHORED
 * semantics. Like `matchLiteralPattern` except a WHOLE-SEGMENT `:name` (a `:`
 * right after `/` or at the start of the pattern, whose name is any non-empty
 * run of non-`/` characters — NOT just JS-identifier chars, so `:post-id`,
 * `:post.id`, etc. all anchor — running up to the next `/` or end of string)
 * matches exactly ONE non-empty path segment (`[^/]+`). A whole-segment NAMED
 * CATCH-ALL `:name{.+}` (a named catch-all page `[...path]` → `/docs/:path{.+}`)
 * matches ONE-OR-MORE characters that MAY cross `/` (`.+`, so `/docs/a` and
 * `/docs/a/b` both match, but bare `/docs` / `/docs/` do NOT). Only the exact
 * `{.+}` constraint widens — a REGEX-constrained param like `:path{[0-9]+}`
 * keeps its single-segment `[^/]+` meaning. `*` still expands to a catch-all
 * that crosses `/`. A mid-segment `:` (e.g. `/api/v1:health`,
 * `/api/documents:batchGet`) stays a LITERAL — only whole-segment `:name` /
 * `:name{.+}` anchors.
 *
 * This is for `routing.revalidate` keys ONLY. Those keys are machine-generated
 * from page routes on the deploy write side (`[slug]` → `/blog/:slug`,
 * `[...path]` → `/docs/:path{.+}`), so the `:name` here is a real route param
 * and MUST bind the same way the framework's own client route matcher
 * (`patternToRegex` in `pages/manifest.ts`) binds it.
 *
 * It is intentionally NOT used for user-authored header rules
 * (`applyHeaderRules`) or `revalidateQueryAllowlist` keys
 * (`buildVariantOriginalUrl`), where `:name` must stay a literal — those keep
 * using `matchLiteralPattern`. Sharing the segment behaviour there would make a
 * user rule like `/:batchGet` over-match every single-segment path.
 *
 * NOTE: this matcher has its OWN regex cache — the same pattern string compiles
 * to a DIFFERENT regex than `matchLiteralPattern` produces, so the caches must
 * not be shared or they would cross-contaminate.
 */
export function matchSegmentPattern(pattern: string, pathname: string): boolean {
  let regex = lruGet(segmentRegexCache, pattern);
  if (!regex) {
    try {
      // Two private-use sentinels stand in for route params so the regex-special
      // escape step below can't touch the classes we swap in last:
      //   \uE000 - a whole-segment `:name`       -> one path segment (`[^/]+`)
      //   \uE001 - a named catch-all `:name{.+}`  -> >=1 char, crosses `/` (`.+`)
      // The named-catch-all rule runs FIRST so `:name{.+}` is consumed as a unit
      // before the plain `:name` rule can grab `:name` and strand the `{.+}`. The
      // `{.+}` name class is `[^/{}]+` (excludes braces) so a REGEX-constrained
      // param like `:path{[0-9]+}` does NOT match and stays a single segment.
      const escaped = pattern
        .replace(/(^|\/):[^/{}]+\{\.\+\}(?=\/|$)/g, '$1\uE001') // named catch-all :name{.+} -> catch-all sentinel
        .replace(/(^|\/):[^/]+(?=\/|$)/g, '$1\uE000') // whole-segment :name -> segment sentinel
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
        .replaceAll('*', '.*') // legacy `*` crosses '/'
        .replaceAll('\uE000', '[^/]+') // segment sentinel -> one segment
        .replaceAll('\uE001', '.+'); // catch-all sentinel -> >=1 char, crosses '/'
      regex = new RegExp(`^${escaped}$`);
    } catch {
      return false;
    }
    lruSet(segmentRegexCache, pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Substitute `:name` and `:name*` tokens in a destination string with the
 * matching named captures from `params`. `:splat` works for legacy `*` patterns
 * because `compilePattern` captures anonymous `*` as `splat`.
 */
export function substituteParams(destination: string, params: Record<string, string>): string {
  return destination.replace(/:([A-Za-z0-9_]+)\*?/g, (whole, name: string) => {
    return params[name] ?? whole;
  });
}
