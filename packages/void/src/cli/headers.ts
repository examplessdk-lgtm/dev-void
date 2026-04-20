import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { voidWarn } from '../log';
import type { HeaderRule, RedirectRule } from './types';

/**
 * Result of parsing a `_redirects` file.
 *
 * `redundantForceOn3xx` counts entries that used a `!` force suffix on a 3xx
 * status (e.g. `301!`, `302!`, `307!`, `308!`). The `!` is a no-op on 3xx
 * (a redirect always "forces" by nature — it changes the URL), so we silently
 * strip it and let callers aggregate a single friendly warning at deploy time.
 */
export interface ParsedRedirects {
  rules: RedirectRule[];
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
      current = { pattern: trimmed, headers: [] };
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
  const rules: Array<RedirectRule> = [];
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
      rules.push({ source, destination, status, force, origin });
    } else if (status >= 300 && status < 400) {
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
export function splitRedirectRulesByForce(rules: RedirectRule[] | undefined): {
  always: RedirectRule[];
  fallbacks: RedirectRule[];
} {
  const always: RedirectRule[] = [];
  const fallbacks: RedirectRule[] = [];
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
