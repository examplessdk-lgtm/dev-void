import type { RedirectRule } from '@void/deploy-core';
import { compilePattern, matchPatternCaptures, substituteParams } from './pattern.ts';

export type { RedirectRule } from '@void/deploy-core';

export type RoutingRuleResult =
  | { type: 'redirect'; destination: string; status: number }
  | { type: 'rewrite'; destination: string };

/**
 * Check routing rules (redirects + rewrites) against a request pathname.
 *
 * **First match wins** — matches Netlify `_redirects` and Vercel `vercel.json`
 * semantics: users put more-specific rules above more-general ones, and the
 * first rule whose source matches takes effect. (Header rules in this same
 * package use last-match-wins for compatibility with Netlify `_headers`,
 * which is the opposite of `_redirects`. The asymmetry is intentional.)
 *
 * `requestHost` is the WHATWG `url.hostname` (lowercase, port-stripped).
 * Rules with a `host` field are skipped when `rule.host !== requestHost`;
 * path-only rules apply to every host bound to the project.
 *
 * Returns a discriminated result. The caller is responsible for building the
 * actual `Response` for redirects (so it can merge the request's query string
 * into the `Location` header).
 */
export function applyRoutingRules(
  pathname: string,
  rules?: ReadonlyArray<RedirectRule>,
  requestHost?: string,
): RoutingRuleResult | null {
  if (!rules?.length) {
    return null;
  }

  for (const rule of rules) {
    if (rule.host && rule.host !== requestHost) {
      continue;
    }
    try {
      compilePattern(rule.source);
    } catch (err) {
      // A malformed `source` (e.g. duplicate named params) throws here.
      // Framework validation rejects those at build, but a hand-crafted
      // manifest could still reach the edge. Skip the offending rule and
      // continue rather than 500ing the whole request.
      console.warn(
        `[dispatch] skipping routing rule with invalid source ${JSON.stringify(rule.source)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const params = matchPatternCaptures(rule.source, pathname);
    if (!params) {
      continue;
    }

    const destination = substituteParams(rule.destination, params);

    if (rule.status === 200) {
      return { type: 'rewrite', destination };
    }

    return { type: 'redirect', destination, status: rule.status };
  }

  return null;
}

/**
 * Merge a request's query string into a redirect destination.
 *
 * If the destination already contains a `?`, its parameters take precedence
 * over the request's. Otherwise the request's query is appended verbatim.
 *
 * A `#fragment` on the destination is stripped before the merge and
 * re-appended afterwards, so `/new#faq` + `?utm=x` becomes `/new?utm=x#faq`
 * rather than `/new#faq?utm=x` (which browsers treat as fragment text).
 */
export function mergeQueryIntoLocation(destination: string, requestSearch: string): string {
  if (!requestSearch || requestSearch === '?') {
    return destination;
  }
  const fragIdx = destination.indexOf('#');
  const base = fragIdx === -1 ? destination : destination.slice(0, fragIdx);
  const fragment = fragIdx === -1 ? '' : destination.slice(fragIdx);

  const destQueryIdx = base.indexOf('?');
  if (destQueryIdx === -1) {
    return base + requestSearch + fragment;
  }
  if (destQueryIdx === base.length - 1) {
    return base.slice(0, destQueryIdx) + fragment;
  }
  const reqParams = new URLSearchParams(requestSearch);
  const destParams = new URLSearchParams(base.slice(destQueryIdx + 1));
  for (const [key, value] of reqParams) {
    if (!destParams.has(key)) {
      destParams.append(key, value);
    }
  }
  return base.slice(0, destQueryIdx) + '?' + destParams.toString() + fragment;
}
