import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
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
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:1' },
      { source: '/blog/*', destination: '/posts/:splat', status: 302, origin: '_redirects:2' },
    ]);
  });

  it('returns undefined when file does not exist', () => {
    setup(); // no file
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('skips comments and blank lines', () => {
    setup('# comment\n\n/old /new 301\n# another comment\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: '_redirects:3' },
    ]);
  });

  it('defaults status to 302 when omitted', () => {
    setup('/old /new\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/old', destination: '/new', status: 302, origin: '_redirects:1' },
    ]);
  });

  it('includes 200 rewrites alongside 3xx redirects', () => {
    setup('/app/* /index.html 200\n/old /new 301\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
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
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: true,
        origin: '_redirects:1',
      },
    ]);
  });

  it('distinguishes force (200!) from non-force (200) rules in the same file', () => {
    setup('/fallback /spa.html 200\n/api/* /backend/:splat 200!\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
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

  it('rejects force suffix on non-200 statuses like 301!', () => {
    setup('/old /new 301!\n/ok /new 301\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('tolerates extra whitespace between fields', () => {
    setup('  /app/*   /index.html    200!  \n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
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
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/blog/*', destination: '/posts/:splat', status: 301, origin: '_redirects:1' },
    ]);
  });

  it('returns undefined for file with only comments', () => {
    setup('# just a comment\n# another one\n');
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('parses file with only 200 rewrites', () => {
    setup('/app/* /index.html 200\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
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
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      { source: '/ok', destination: '/new', status: 301, origin: '_redirects:2' },
    ]);
  });

  it('skips 200 rewrites with external destinations', () => {
    setup('/api/* https://upstream.example/:splat 200\n/app/* /index.html 200\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([
      {
        source: '/app/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: '_redirects:2',
      },
    ]);
  });

  it('tags origin with line number when destination is external (skipped)', () => {
    setup('# header\n/fallback /spa.html 200\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules?.[0].origin).toBe('_redirects:2');
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
