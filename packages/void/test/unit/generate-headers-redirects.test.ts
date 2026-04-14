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
      { source: '/old', destination: '/new', status: 301 },
      { source: '/blog/*', destination: '/posts/:splat', status: 302 },
    ]);
  });

  it('returns undefined when file does not exist', () => {
    setup(); // no file
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('skips comments and blank lines', () => {
    setup('# comment\n\n/old /new 301\n# another comment\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([{ source: '/old', destination: '/new', status: 301 }]);
  });

  it('defaults status to 302 when omitted', () => {
    setup('/old /new\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([{ source: '/old', destination: '/new', status: 302 }]);
  });

  it('skips 200 rewrites (only includes 3xx)', () => {
    setup('/app/* /index.html 200\n/old /new 301\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([{ source: '/old', destination: '/new', status: 301 }]);
  });

  it('handles :splat destinations (preserved as-is)', () => {
    setup('/blog/* /posts/:splat 301\n');
    const rules = parseRedirectsFile(tmpDir);
    expect(rules).toEqual([{ source: '/blog/*', destination: '/posts/:splat', status: 301 }]);
  });

  it('returns undefined for file with only comments', () => {
    setup('# just a comment\n# another one\n');
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });

  it('returns undefined for file with only 200 rewrites', () => {
    setup('/app/* /index.html 200\n');
    expect(parseRedirectsFile(tmpDir)).toBeUndefined();
  });
});
