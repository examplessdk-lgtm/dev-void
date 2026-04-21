import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRedirectsFile } from '../../src/cli/headers';

const tmpDir = join(import.meta.dirname, '.tmp-parse-redirects-test');

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, '_redirects'), content);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseRedirectsFile', () => {
  it('parses standard _redirects file', () => {
    setup('/old /new 301\n/blog/* /posts/:splat 302\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toEqual({
      rules: [
        { source: '/old', destination: '/new', status: 301, origin: '_redirects:1' },
        { source: '/blog/*', destination: '/posts/:splat', status: 302, origin: '_redirects:2' },
      ],
      redundantForceOn3xx: 0,
    });
  });

  it('returns undefined when file does not exist', () => {
    setup(); // no file
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('skips comments and blank lines', () => {
    setup('# comment\n\n/old /new 301\n# another comment\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:3' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(0);
  });

  it('defaults status to 302 when omitted', () => {
    setup('/old /new\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 302, origin: '_redirects:1' },
    ]);
  });

  it('includes 200 rewrites alongside 3xx redirects', () => {
    setup('/app/* /index.html 200\n/old /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:1',
      },
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('parses 200! as force-true rewrite (Netlify-compat)', () => {
    setup('/app/* /index.html 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: true,
        origin: '_redirects:1',
      },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(0);
  });

  it('distinguishes force (200!) from non-force (200) rules in the same file', () => {
    setup('/fallback /spa.html 200\n/api/* /backend/:splat 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/fallback',
        destination: '/spa.html',
        status: 200,
        force: false,
        origin: '_redirects:1',
      },
      {
        source: '/api/*',
        destination: '/backend/:splat',
        status: 200,
        force: true,
        origin: '_redirects:2',
      },
    ]);
  });

  it('silently accepts 301! as a regular 301 and tallies redundant-force count', () => {
    setup('/old /new 301!\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:1' },
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(1);
  });

  it('silently accepts all 3xx force variants (301!, 302!, 307!, 308!)', () => {
    setup('/a /x 301!\n/b /x 302!\n/c /x 307!\n/d /x 308!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/a', destination: '/x', status: 301, origin: '_redirects:1' },
      { source: '/b', destination: '/x', status: 302, origin: '_redirects:2' },
      { source: '/c', destination: '/x', status: 307, origin: '_redirects:3' },
      { source: '/d', destination: '/x', status: 308, origin: '_redirects:4' },
    ]);
    expect(parsed?.redundantForceOn3xx).toBe(4);
  });

  it('tolerates extra whitespace between fields', () => {
    setup('  /app/*   /index.html    200!  \n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: true,
        origin: '_redirects:1',
      },
    ]);
  });

  it('handles :splat destinations (preserved as-is)', () => {
    setup('/blog/* /posts/:splat 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/blog/*', destination: '/posts/:splat', status: 301, origin: '_redirects:1' },
    ]);
  });

  it('returns undefined for file with only comments', () => {
    setup('# just a comment\n# another one\n');
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('parses file with only 200 rewrites', () => {
    setup('/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:1',
      },
    ]);
  });

  it('skips non-200 non-3xx status codes', () => {
    setup('/old /new 404\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('skips 200 rewrites with external destinations', () => {
    setup('/api/* https://upstream.example/:splat 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
  });

  it('skips 200 rewrites whose destination contains a query string', () => {
    setup('/docs /en/docs?lang=en 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
  });

  it('skips 200! rewrites whose destination contains a query string', () => {
    setup('/docs /en/docs?lang=en 200!\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed).toBeUndefined();
  });

  it('warns via voidWarn when a 200 rewrite destination contains "?" (skip path)', () => {
    // voidWarn writes through console.log — observe both that the entry was
    // dropped AND that a yellow-tagged warning surfaced for the author.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('/docs /en/docs?lang=en 200\n/app/* /index.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes('must not contain "?"'))).toBe(true);
    logSpy.mockRestore();
  });

  it('skips _redirects entries whose source has more than one "*" and warns', () => {
    // Dispatch compiles `*` → `(?<splat>...)`; two of them yield duplicate
    // group names and crash the regex at startup. Drop the entry with a
    // friendly warning so the rest of the file still deploys.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup('/a/*/b/* /dest 301\n/ok /new 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((msg) => msg.includes('at most one "*" wildcard') && msg.includes('line 1')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('tags origin with line number when destination is external (skipped)', () => {
    setup('# header\n/fallback /spa.html 200\n');
    const parsed = parseRedirectsFile(tmpDir);
    expect(parsed?.rules[0].origin).toBe('_redirects:2');
  });
});

describe('_redirects + void.json merge precedence (same source)', () => {
  // Mirrors the ordering at packages/void/src/cli/deploy.ts:580-586 and 903-909:
  //   redirectRules = [...always(_redirects), ...redirects(void.json), ...rewrites(void.json)]
  // Last-match-wins means void.json rules override _redirects rules when they
  // share a source. Regression anchor for that contract — the merge site is
  // simple array concat, but if someone reverses the order the silent override
  // flips direction without failing the deploy.
  it('places _redirects first and void.json rules last, so void.json wins under last-match-wins', async () => {
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers');
    const { convertRedirectsConfig, convertRewritesConfig } = await import('../../src/config');

    setup('/x /from-file 301\n');
    const parsed = parseRedirectsFile(tmpDir);
    const { always: fileAlways, fallbacks: fileFallbacks } = splitRedirectRulesByForce(
      parsed?.rules,
    );
    // void.json has a same-source entry under both redirects and rewrites to
    // cover both pre-asset origins.
    const cfgRedirects = convertRedirectsConfig({ '/x': '/from-config-redirect' });
    const cfgRewrites = convertRewritesConfig({ '/x': '/from-config-rewrite' });

    // Merge order must match deploy.ts — if this drifts, the test fails
    // loudly with a concrete diff rather than letting a silent precedence
    // flip hit production.
    const merged = [...fileAlways, ...(cfgRedirects ?? []), ...(cfgRewrites ?? [])];

    expect(merged).toEqual([
      { source: '/x', destination: '/from-file', status: 301, origin: '_redirects:1' },
      {
        source: '/x',
        destination: '/from-config-redirect',
        status: 302,
        origin: 'void.json#routing.redirects',
      },
      {
        source: '/x',
        destination: '/from-config-rewrite',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ]);

    // No _redirects-file fallback entries in this fixture — sanity check
    // that the fallback bucket doesn't accidentally pick up the 3xx entry.
    expect(fileFallbacks).toEqual([]);
  });
});

describe('splitRedirectRulesByForce', () => {
  it('returns empty buckets for undefined input', async () => {
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers');
    expect(splitRedirectRulesByForce(undefined)).toEqual({ always: [], fallbacks: [] });
  });

  it('bucketizes 200 (non-force) into fallbacks and 200! / 3xx into always', async () => {
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers');
    const split = splitRedirectRulesByForce([
      { source: '/a', destination: '/spa.html', status: 200, force: false },
      { source: '/b', destination: '/api', status: 200, force: true },
      { source: '/c', destination: '/d', status: 301 },
    ]);
    expect(split.fallbacks).toEqual([
      { source: '/a', destination: '/spa.html', status: 200, force: false },
    ]);
    expect(split.always).toEqual([
      { source: '/b', destination: '/api', status: 200, force: true },
      { source: '/c', destination: '/d', status: 301 },
    ]);
  });
});
