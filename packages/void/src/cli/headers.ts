import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeaderRule, RedirectRule } from './types';

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
export function parseHeadersFile(dir: string): HeaderRule[] | undefined {
  const filePath = join(dir, '_headers');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: HeaderRule[] = [];
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
 * Parse a `_redirects` file into RedirectRule[].
 * Format: `source destination [status]` per line (status defaults to 302).
 * Lines starting with # are comments. Only 3xx redirects are included (200 rewrites skipped).
 */
export function parseRedirectsFile(dir: string): RedirectRule[] | undefined {
  const filePath = join(dir, '_redirects');
  if (!existsSync(filePath)) {
    return undefined;
  }

  const content = readFileSync(filePath, 'utf-8');
  const rules: RedirectRule[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }

    const [source, destination, statusStr] = parts;
    const status = statusStr ? parseInt(statusStr, 10) : 302;

    // Only include actual redirects (3xx), skip rewrites (200)
    if (status >= 300 && status < 400) {
      rules.push({ source, destination, status });
    }
  }

  return rules.length > 0 ? rules : undefined;
}
