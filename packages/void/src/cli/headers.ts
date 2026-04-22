import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  convertFallbacksConfig,
  convertHeadersConfig,
  convertRedirectsConfig,
  convertRewritesConfig,
  countSplats,
  VALID_REDIRECT_STATUSES,
  type RoutingConfig,
} from '../config';
import { voidWarn } from '../log';
import type { DevRedirectRule, HeaderRule } from './types';

/**
 * Result of parsing a `_redirects` file.
 *
 * `redundantForceOn3xx` counts entries that used a `!` force suffix on a 3xx
 * status (e.g. `301!`, `302!`, `307!`, `308!`). The `!` is a no-op on 3xx
 * (a redirect always "forces" by nature — it changes the URL), so we silently
 * strip it and let callers aggregate a single friendly warning at deploy time.
 */
export interface ParsedRedirects {
  rules: Array<DevRedirectRule>;
  redundantForceOn3xx: number;
}

/**
 * Parse a Cloudflare/Netlify `_headers` file into HeaderRule[].
 *
 * Format:
 *   - Non-indented lines = path pattern (starts a new block)
 *   - Indented lines = `Header-Name: value` (split on first `:`)
 *   - Lines starting with `#` are comments
 *   - `! Header-Name` unset directives are skipped (last-match-wins handles this)
 *
 * Output is sorted by pattern length ascending (shortest first) so that
 * more-specific patterns come last — matching dispatch's last-match-wins semantics.
 *
 * Returns `undefined` if the file doesn't exist or yields no valid rules.
 */
export function parseHeadersFile(dir: string): Array<HeaderRule> | undefined {
  const filePath = join(dir, '_headers');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: Array<HeaderRule> = [];
  let current: HeaderRule | null = null;

  for (const line of content.split('\n')) {
    // Skip blank lines and comments
    const trimmed = line.trimEnd();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Indented line = header within current block
    if (line[0] === ' ' || line[0] === '\t') {
      if (!current) {
        continue;
      }
      const stripped = trimmed.trimStart();
      // Skip unset directives (! Header-Name)
      if (stripped.startsWith('!')) {
        continue;
      }
      const colonIdx = stripped.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }
      const name = stripped.slice(0, colonIdx).trim();
      const value = stripped.slice(colonIdx + 1).trim();
      if (name) {
        current.headers.push([name, value]);
      }
    } else {
      // Non-indented line = path pattern (new block)
      if (current && current.headers.length > 0) {
        rules.push(current);
      }
      // Drop blocks whose pattern would crash pattern compilation at runtime
      // (two `*` → duplicate `splat` capture group). Warn so the author can
      // fix the file, but keep the rest of the manifest valid.
      if (countSplats(trimmed) > 1) {
        voidWarn(
          `Skipping _headers block for "${trimmed}": pattern must contain at most one "*" wildcard (captured as :splat).`,
        );
        current = null;
      } else {
        current = { pattern: trimmed, headers: [] };
      }
    }
  }

  // Flush last block
  if (current && current.headers.length > 0) {
    rules.push(current);
  }

  if (rules.length === 0) {
    return undefined;
  }

  // Sort by pattern length ascending: shorter (less specific) first,
  // longer (more specific) last — last-match-wins = most-specific-wins
  rules.sort((a, b) => a.pattern.length - b.pattern.length);

  return rules;
}

/**
 * Parse a `_redirects` file.
 *
 * Format: `source destination [status]` per line (status defaults to 302).
 * Lines starting with # are comments. Includes 3xx redirects and 200 rewrites.
 *
 * Force suffix (`!`) semantics:
 *   - On status 200: toggles `force: true` (Netlify-compat). The plain form
 *     fires only when the static asset would 404; the force form fires
 *     unconditionally, overriding any matching static asset.
 *   - On 3xx (301/302/307/308): silently stripped. A redirect always changes
 *     the URL, so `!` is redundant. We count these in `redundantForceOn3xx`
 *     so the deploy command can surface a single aggregated lint warning
 *     rather than one per line — Netlify users pasting their `_redirects`
 *     file shouldn't be punished for harmless cruft.
 *
 * Returns `undefined` when the file doesn't exist or yields no valid rules.
 * Otherwise returns `{rules, redundantForceOn3xx}`.
 */
export function parseRedirectsFile(dir: string): ParsedRedirects | undefined {
  const filePath = join(dir, '_redirects');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: Array<DevRedirectRule> = [];
  let redundantForceOn3xx = 0;

  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = rawLines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }

    const origin = `_redirects:${lineNumber}`;

    const [source, destination, statusStr] = parts;

    // The dispatch worker compiles each `*` into a `(?<splat>...)` capture
    // group; two of them in one pattern yield a duplicate-group-name RegExp
    // error at startup. Skip with a clear warning so other rules in the file
    // still deploy, matching the "skip + warn" pattern used for invalid
    // destinations below.
    if (countSplats(source) > 1) {
      voidWarn(
        `Skipping _redirects entry "${source} ${destination}${statusStr ? ` ${statusStr}` : ''}" (line ${lineNumber}): source must contain at most one "*" wildcard (captured as :splat).`,
      );
      continue;
    }
    let status: number;
    let force = false;
    if (statusStr) {
      if (statusStr.endsWith('!')) {
        const numericPart = statusStr.slice(0, -1);
        status = parseInt(numericPart, 10);
        if (status === 200) {
          force = true;
        } else if (status >= 300 && status < 400) {
          // `!` on a 3xx is a no-op — redirects always change the URL.
          // Accept silently (stripping the suffix) and tally for the
          // deploy-time aggregated lint so users can clean up if they want.
          redundantForceOn3xx++;
        }
        // Non-200/non-3xx with `!` falls through to the status range check
        // below, which skips non-200 non-3xx codes entirely.
      } else {
        status = parseInt(statusStr, 10);
      }
    } else {
      status = 302;
    }

    // Include redirects (3xx) and rewrites (200). Status-200 entries are
    // internal rewrites; proxy-style rules pointing at an external URL are
    // not supported — skip them with a warning to match the "internal paths
    // only" contract enforced for `routing.rewrites` in void.json.
    if (status === 200) {
      if (!destination.startsWith('/')) {
        voidWarn(
          `Skipping _redirects rewrite "${source} ${destination} ${force ? '200!' : '200'}": destination must start with "/" (only internal paths are supported).`,
        );
        continue;
      }
      // Protocol-relative ("//host/x") passes the single-slash check but
      // parses as a cross-origin URL when dispatch applies the manifest,
      // silently turning an internal rewrite into a proxy. Mirrors the
      // `c.rewrite()` codegen guard in router/compile.ts (commit 3c60d38)
      // and the `void.json` rewrite/fallback validators in config.ts.
      if (destination.startsWith('//')) {
        voidWarn(
          `Skipping _redirects rewrite "${source} ${destination} ${force ? '200!' : '200'}": destination must not start with "//" (protocol-relative URLs parse as cross-origin; only internal paths are supported).`,
        );
        continue;
      }
      if (destination.includes('?')) {
        voidWarn(
          `Skipping _redirects rewrite "${source} ${destination} ${force ? '200!' : '200'}": destination must not contain "?" (query strings are not supported in rewrite destinations; the incoming request's query is preserved automatically).`,
        );
        continue;
      }
      rules.push({ source, destination, status, force, origin });
    } else if (status >= 300 && status < 400) {
      if (!VALID_REDIRECT_STATUSES.has(status)) {
        voidWarn(
          `Skipping _redirects entry "${source} ${destination} ${statusStr}" (line ${lineNumber}): redirect status must be 301, 302, 303, 307, or 308.`,
        );
        continue;
      }
      rules.push({ source, destination, status, origin });
    }
  }

  if (rules.length === 0 && redundantForceOn3xx === 0) {
    return undefined;
  }

  return { rules, redundantForceOn3xx };
}

/**
 * Split parsed `_redirects` rules into "always-apply" and "asset-miss only"
 * buckets. Rules with `status: 200` and `force === false` are fallbacks — they
 * should only fire when the static asset resolver would 404. All other rules
 * (3xx redirects and forced `200!` rewrites) stay in the "always" bucket and
 * are merged with `routing.rewrites` / `routing.redirects` from void.json.
 */
export function splitRedirectRulesByForce(rules: Array<DevRedirectRule> | undefined): {
  always: Array<DevRedirectRule>;
  fallbacks: Array<DevRedirectRule>;
} {
  const always: Array<DevRedirectRule> = [];
  const fallbacks: Array<DevRedirectRule> = [];
  if (!rules) {
    return { always, fallbacks };
  }
  for (const rule of rules) {
    if (rule.status === 200 && rule.force !== true) {
      fallbacks.push(rule);
    } else {
      always.push(rule);
    }
  }
  return { always, fallbacks };
}

/**
 * Merge file-based rules (`_redirects`, `_headers`) in `dir` with routing
 * rules from `void.json`. Shared between the deploy pipeline and the dev
 * plugin so both surfaces produce identical rule tables.
 *
 * Ordering: file rules first, then `void.json` rules. Because the router
 * evaluates rules with last-match-wins semantics, `void.json` entries
 * override `_redirects` entries for the same source — matching the
 * documented precedence (`docs/guide/edge/rewrites.md`). This holds even
 * though `_redirects` is conceptually "closer to the build output".
 *
 * Phase split:
 *   - `_redirects` `200!` (force) + 3xx entries → `redirectRules` (always-fire)
 *   - `_redirects` plain `200`           entries → `fallbackRules` (asset-miss)
 *   - `routing.redirects` + `routing.rewrites`    → `redirectRules`
 *   - `routing.fallbacks`                         → `fallbackRules`
 *
 * Returns `fallbackRules === undefined` when empty so callers that default to
 * "no post-asset phase" behave identically to the old deploy code.
 *
 * Duplicate linting is NOT called here (callers decide which warning surface
 * to use — CLI vs. Vite logger). `redundantForceOn3xx` is returned raw for
 * the same reason.
 */
export function mergeRoutingRules(opts: { dir: string; routing: RoutingConfig | undefined }): {
  headerRules: Array<HeaderRule>;
  redirectRules: Array<DevRedirectRule>;
  fallbackRules: Array<DevRedirectRule> | undefined;
  redundantForceOn3xx: number;
} {
  const { dir, routing } = opts;
  const dirExists = existsSync(dir);

  const fileHeaders = dirExists ? parseHeadersFile(dir) : undefined;
  const fileParsed = dirExists ? parseRedirectsFile(dir) : undefined;
  const { always: fileAlways, fallbacks: fileFallbacks } = splitRedirectRulesByForce(
    fileParsed?.rules,
  );

  const cfgHeaders = convertHeadersConfig(routing?.headers);
  const cfgRedirects = convertRedirectsConfig(routing?.redirects);
  const cfgRewrites = convertRewritesConfig(routing?.rewrites);
  const cfgFallbacks = convertFallbacksConfig(routing?.fallbacks);

  const headerRules: Array<HeaderRule> = [...(fileHeaders ?? []), ...(cfgHeaders ?? [])];
  const redirectRules: Array<DevRedirectRule> = [
    ...fileAlways,
    ...(cfgRedirects ?? []),
    ...(cfgRewrites ?? []),
  ];
  const mergedFallbacks = [...fileFallbacks, ...(cfgFallbacks ?? [])];
  const fallbackRules = mergedFallbacks.length > 0 ? mergedFallbacks : undefined;

  return {
    headerRules,
    redirectRules,
    fallbackRules,
    redundantForceOn3xx: fileParsed?.redundantForceOn3xx ?? 0,
  };
}

/**
 * Warn when a rule's `destination` contains a literal `*`. The platform's
 * `substituteParams` only replaces `:name` tokens (e.g. `:splat`, `:id`) —
 * bare `*` in destinations is a literal character, not a capture reference,
 * and will silently pass through to the rewritten/redirected URL.
 *
 * Users who write `/old/*` → `/new/*` almost always intended `:splat` to
 * reflect the captured portion of the source wildcard. Surface the mistake
 * with a single aggregated warning at the same surface as
 * `lintDuplicateSources` — per-phase, near the merge site — rather than
 * failing the deploy: a `*` in a destination is well-formed output, just
 * probably not what was meant.
 *
 * Only reported once per rule (the count of `*` in the destination is
 * irrelevant — a single occurrence is already suspicious). Returns the
 * warning message for test observability; `undefined` when no destinations
 * contain `*`. The `warn` callback defaults to `voidWarn` and is injectable
 * so tests can capture output without stubbing the module.
 */
export function lintDestinationSplats(
  rules: Array<DevRedirectRule> | undefined,
  phaseName: string,
  warn: (msg: string) => void = voidWarn,
): string | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }

  const affected: Array<DevRedirectRule> = [];
  for (const rule of rules) {
    if (rule.destination.includes('*')) {
      affected.push(rule);
    }
  }

  if (affected.length === 0) {
    return undefined;
  }

  const longestSource = affected.reduce((n, r) => Math.max(n, r.source.length), 0);
  const lines = affected.map((rule) => {
    const origin = rule.origin ?? '<unknown>';
    return `  ${rule.source.padEnd(longestSource)}  → ${rule.destination}  (${origin})`;
  });

  const message = [
    `Warning: destinations in ${phaseName} contain a literal "*" — splat tokens are not substituted in destinations; use ":splat" (or other named params) or rewrite the destination:`,
    ...lines,
  ].join('\n');

  warn(message);
  return message;
}

/**
 * Warn when the same `source` pattern appears more than once within a single
 * merged phase (pre-asset `redirectRules` or post-asset `fallbackRules`).
 *
 * Sources are scoped to the phase: a pattern appearing once in redirects and
 * once in fallbacks is *not* a collision, because those lists run in separate
 * phases and don't shadow each other. Within a single phase the dispatcher
 * uses last-match-wins semantics, so a duplicate silently hides the earlier
 * entry. This lint never fails the deploy; it surfaces the collision so the
 * user can decide whether to fix it.
 *
 * Only exact string duplicates are reported. Subset-shadow cases (e.g. `/*`
 * overshadowing `/docs`) are out of scope — pattern-aware analysis would be
 * both harder and noisier.
 *
 * Emits a single aggregated warning summarizing every duplicated source, each
 * annotated with the `origin` of every occurrence (e.g. `_redirects:12` vs
 * `void.json#routing.rewrites`). Aggregation avoids a wall of per-pair
 * warnings on configs with many collisions.
 *
 * Returns the warning message for test observability; `undefined` when the
 * input is unique. The `warn` callback defaults to `voidWarn` and is
 * injectable so tests can capture output without stubbing the module.
 */
export function lintDuplicateSources(
  rules: Array<DevRedirectRule> | undefined,
  phaseName: string,
  warn: (msg: string) => void = voidWarn,
): string | undefined {
  if (!rules || rules.length < 2) {
    return undefined;
  }

  const bySource = new Map<string, Array<DevRedirectRule>>();
  for (const rule of rules) {
    const existing = bySource.get(rule.source);
    if (existing) {
      existing.push(rule);
    } else {
      bySource.set(rule.source, [rule]);
    }
  }

  const duplicates: Array<{ source: string; occurrences: Array<DevRedirectRule> }> = [];
  for (const [source, occurrences] of bySource) {
    if (occurrences.length > 1) {
      duplicates.push({ source, occurrences });
    }
  }

  if (duplicates.length === 0) {
    return undefined;
  }

  const longestSource = duplicates.reduce((n, d) => Math.max(n, d.source.length), 0);

  const lines = duplicates.map(({ source, occurrences }) => {
    const origins = occurrences.map((rule) => rule.origin ?? '<unknown>');
    const joined =
      origins.length === 2
        ? origins.join(' and ')
        : `${origins.slice(0, -1).join(', ')}, and ${origins[origins.length - 1]}`;
    return `  ${source.padEnd(longestSource)}  — ${joined}`;
  });

  const message = [
    `Warning: duplicate rule sources detected in ${phaseName} (last match wins — the later entry takes effect):`,
    ...lines,
  ].join('\n');

  warn(message);
  return message;
}
