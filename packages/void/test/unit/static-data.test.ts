import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveStaticPageDataBuildOptions } from '../../src/pages/static-data';

const tmpDir = join(import.meta.dirname, '.tmp-static-data-test');

function setupConfig(content: Record<string, unknown>): void {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'void.json'), JSON.stringify(content));
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveStaticPageDataBuildOptions', () => {
  it('disables the fast path when output is not "static"', () => {
    setupConfig({ output: 'server' });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.enabled).toBe(false);
    expect(opts.fastPath).toBe(false);
  });

  it('enables the fast path for static builds with no routing rules', () => {
    setupConfig({ output: 'static' });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.enabled).toBe(true);
    expect(opts.fastPath).toBe(true);
  });

  it('disables the fast path when routing.redirects is non-empty', () => {
    // Existing guard — covered for completeness.
    setupConfig({ output: 'static', routing: { redirects: { '/old': '/new' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('disables the fast path when routing.rewrites is non-empty', () => {
    // Regression: the fast-path client request goes to
    // /_void/pages/<path>.json, never the user-facing URL, so dispatch's
    // edge rewrite never fires. The fast path must be disabled when any
    // config rewrite is defined or the client commits unrewritten page data.
    setupConfig({ output: 'static', routing: { rewrites: { '/old': '/new' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('disables the fast path when routing.fallbacks is non-empty', () => {
    // Same logic as rewrites — fallback rules can also alter response body
    // shape, and the fast path bypasses the dispatch fallback phase.
    setupConfig({ output: 'static', routing: { fallbacks: { '/missing': '/index' } } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(false);
  });

  it('keeps the fast path enabled when only routing.headers is set', () => {
    // Header rules don't change response body — they're applied to the
    // page-data JSON the same as any other static asset, so they don't
    // need to disable the fast path.
    setupConfig({
      output: 'static',
      routing: { headers: { '/api/*': ['Cache-Control: no-store'] } },
    });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(true);
  });

  it('keeps the fast path enabled when routing.rewrites is an empty object', () => {
    setupConfig({ output: 'static', routing: { rewrites: {} } });
    const opts = resolveStaticPageDataBuildOptions(tmpDir, { publicDir: false });
    expect(opts.fastPath).toBe(true);
  });
});
