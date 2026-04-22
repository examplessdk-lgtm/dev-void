import { describe, it, expect } from 'vitest';
import { lintDuplicateSources } from '../../src/cli/headers';
import type { DevRedirectRule } from '../../src/cli/types';

function rule(
  source: string,
  origin: string,
  overrides: Partial<DevRedirectRule> = {},
): DevRedirectRule {
  return {
    source,
    destination: '/placeholder',
    status: 200,
    origin,
    ...overrides,
  };
}

describe('lintDuplicateSources', () => {
  it('emits no warning when all sources are unique', () => {
    const warnings: Array<string> = [];
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:1'),
      rule('/api/*', 'void.json#routing.rewrites'),
      rule('/blog/*', 'void.json#routing.redirects', { status: 302 }),
    ];

    const result = lintDuplicateSources(rules, 'redirects', (msg) => warnings.push(msg));

    expect(result).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('emits no warning for an empty or undefined list', () => {
    const warnings: Array<string> = [];
    expect(lintDuplicateSources(undefined, 'x', (m) => warnings.push(m))).toBeUndefined();
    expect(lintDuplicateSources([], 'x', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('emits a single aggregated warning when _redirects and routing.rewrites share a source', () => {
    const warnings: Array<string> = [];
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      rule('/api/*', 'void.json#routing.redirects', { status: 302 }),
      rule('/docs/*', 'void.json#routing.rewrites'),
    ];

    const result = lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)', (msg) =>
      warnings.push(msg),
    );

    // One aggregated warning, not one per pair
    expect(warnings).toHaveLength(1);
    expect(result).toBe(warnings[0]);

    const msg = warnings[0];
    // Preamble explains semantics
    expect(msg).toContain('duplicate rule sources detected');
    expect(msg).toContain('last match wins');
    expect(msg).toContain('redirects/rewrites (pre-asset)');

    // The duplicated source appears with both origins on a single line
    expect(msg).toContain('/docs/*');
    expect(msg).toContain('_redirects:12');
    expect(msg).toContain('void.json#routing.rewrites');
    expect(msg).toMatch(/_redirects:12 and void\.json#routing\.rewrites/);

    // The non-duplicated /api/* source must not appear
    expect(msg).not.toContain('/api/*');
  });

  it('treats cross-phase collisions as safe — rewrites vs fallbacks never collide', () => {
    // Callers lint each phase list independently, so a source that lives in
    // one phase and a same-string source in the other phase will never both
    // land in the same list passed to lintDuplicateSources. Simulate that by
    // linting only the rewrites list; the fallbacks entry is absent.
    const warnings: Array<string> = [];
    const rewrites: Array<DevRedirectRule> = [
      rule('/docs/*', 'void.json#routing.rewrites', { force: true }),
    ];
    const fallbacks: Array<DevRedirectRule> = [
      rule('/docs/*', 'void.json#routing.fallbacks', { force: false }),
    ];

    expect(
      lintDuplicateSources(rewrites, 'redirects/rewrites (pre-asset)', (m) => warnings.push(m)),
    ).toBeUndefined();
    expect(
      lintDuplicateSources(fallbacks, 'fallbacks (post-asset)', (m) => warnings.push(m)),
    ).toBeUndefined();

    expect(warnings).toEqual([]);
  });

  it('aggregates multiple duplicate sources into one message', () => {
    const warnings: Array<string> = [];
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      rule('/docs/*', 'void.json#routing.rewrites'),
      rule('/api/*', 'void.json#routing.rewrites'),
      rule('/api/*', 'void.json#routing.rewrites'),
      rule('/blog/*', '_redirects:20'),
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)', (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    const msg = warnings[0];
    // Both duplicated sources are surfaced
    expect(msg).toContain('/docs/*');
    expect(msg).toContain('/api/*');
    // Non-duplicate source is not
    expect(msg).not.toContain('/blog/*');
  });

  it('handles three+ occurrences of the same source with an Oxford-joined origin list', () => {
    const warnings: Array<string> = [];
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      rule('/docs/*', 'void.json#routing.redirects', { status: 302 }),
      rule('/docs/*', 'void.json#routing.rewrites'),
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)', (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    const msg = warnings[0];
    expect(msg).toContain('_redirects:12');
    expect(msg).toContain('void.json#routing.redirects');
    expect(msg).toContain('void.json#routing.rewrites');
    // Comma + "and" join for 3+ origins
    expect(msg).toMatch(/,.*and /);
  });

  it('falls back to <unknown> when a rule is missing an origin', () => {
    const warnings: Array<string> = [];
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      { source: '/docs/*', destination: '/en/docs/:splat', status: 200, force: true },
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)', (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('<unknown>');
  });
});
