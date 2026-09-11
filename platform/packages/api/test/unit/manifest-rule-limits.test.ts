import { describe, expect, it } from 'vite-plus/test';
import {
  MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES,
  MAX_ROUTING_RULES,
  validateManifestShape,
} from '../../src/routes/deploy.ts';

/**
 * Each routing rule compiles a regex per request in dispatch. Without a cap,
 * a manifest with 100k entries exhausts CPU on every project request. The
 * deploy-time validator must reject any list exceeding `MAX_ROUTING_RULES`.
 */
describe('manifest validation: routing rule count caps', () => {
  function manifestWith(field: 'redirectRules' | 'fallbackRules', count: number) {
    const rules: Array<{ source: string; destination: string; status: number }> = [];
    for (let i = 0; i < count; i++) {
      rules.push({ source: `/r${i}`, destination: `/d${i}`, status: 200 });
    }
    return {
      version: 3,
      bindings: {},
      [field]: rules,
    };
  }

  it('accepts a redirectRules list at exactly the limit', () => {
    expect(validateManifestShape(manifestWith('redirectRules', MAX_ROUTING_RULES))).toBeNull();
  });

  it('rejects a redirectRules list one over the limit', () => {
    const err = validateManifestShape(manifestWith('redirectRules', MAX_ROUTING_RULES + 1));
    expect(err).not.toBeNull();
    expect(err).toMatch(/redirectRules/);
    expect(err).toMatch(String(MAX_ROUTING_RULES));
  });

  it('accepts a fallbackRules list at exactly the limit', () => {
    expect(validateManifestShape(manifestWith('fallbackRules', MAX_ROUTING_RULES))).toBeNull();
  });

  it('rejects a fallbackRules list one over the limit', () => {
    const err = validateManifestShape(manifestWith('fallbackRules', MAX_ROUTING_RULES + 1));
    expect(err).not.toBeNull();
    expect(err).toMatch(/fallbackRules/);
    expect(err).toMatch(String(MAX_ROUTING_RULES));
  });
});

describe('manifest validation: revalidateQueryAllowlist shape', () => {
  function manifest(allowlist: unknown) {
    return { version: 3, bindings: {}, revalidateQueryAllowlist: allowlist };
  }

  function allowlistWith(count: number) {
    const allowlist: Record<string, Array<string>> = {};
    for (let i = 0; i < count; i++) {
      allowlist[`/p${i}`] = ['q'];
    }
    return allowlist;
  }

  it('accepts a valid allowlist', () => {
    expect(
      validateManifestShape(manifest({ '/search': ['q', 'page'], '/blog/*': ['page'], '*': [] })),
    ).toBeNull();
  });

  it('accepts an allowlist at exactly the entry limit', () => {
    expect(
      validateManifestShape(manifest(allowlistWith(MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES))),
    ).toBeNull();
  });

  it('rejects an allowlist one over the entry limit', () => {
    const err = validateManifestShape(
      manifest(allowlistWith(MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES + 1)),
    );
    expect(err).toMatch(/revalidateQueryAllowlist/);
    expect(err).toMatch(String(MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES));
  });

  it('rejects a non-object allowlist', () => {
    const err = validateManifestShape(manifest(['/search', 'q']));
    expect(err).toMatch(/revalidateQueryAllowlist/);
  });

  it('rejects entries whose value is not an array', () => {
    const err = validateManifestShape(manifest({ '/search': 'q,page' }));
    expect(err).toMatch(/revalidateQueryAllowlist/);
  });

  it('rejects entries whose array contains a non-string', () => {
    const err = validateManifestShape(manifest({ '/search': ['q', 1] }));
    expect(err).toMatch(/revalidateQueryAllowlist/);
  });

  it('rejects an empty pattern key', () => {
    // An empty source would match nothing useful and almost certainly
    // signals a config bug; reject loudly rather than silently no-op.
    const err = validateManifestShape(manifest({ '': ['q'] }));
    expect(err).toMatch(/revalidateQueryAllowlist/);
  });
});
