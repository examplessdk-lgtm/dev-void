import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importNuxtRouteRules, mergeStructuredRevalidate } from '../../src/cli/nuxt-route-rules';

const tmpDir = join(import.meta.dirname, '.tmp-nuxt-route-rules-test');

function setup(routeRules: Record<string, unknown>) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(tmpDir, '.output'), { recursive: true });
  writeFileSync(join(tmpDir, '.output', 'nitro.json'), JSON.stringify({ config: { routeRules } }));
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('importNuxtRouteRules', () => {
  it('imports ISR, query policy, headers, redirects, and prerender paths', () => {
    setup({
      '/products/**': {
        isr: { expiration: 300, allowQuery: ['color'] },
        headers: { 'Cache-Control': 'public, max-age=300' },
      },
      '/api/badges/**': {
        cache: { swr: true, maxAge: 3600 },
      },
      '/old': {
        redirect: { to: '/new', status: 301 },
        prerender: true,
      },
      '/proxy/**': {
        proxy: 'https://example.com/**',
      },
    });

    const imported = importNuxtRouteRules(tmpDir);
    expect(imported.revalidate).toEqual([
      {
        pattern: '/products/*',
        ttl: 300,
        query: { allow: ['color'] },
        kind: 'page',
        source: 'framework',
      },
      {
        pattern: '/api/badges/*',
        ttl: 3600,
        query: false,
        kind: 'api',
        source: 'framework',
      },
    ]);
    expect(imported.headerRules).toEqual([
      {
        pattern: '/products/*',
        headers: [['Cache-Control', 'public, max-age=300']],
      },
    ]);
    expect(imported.redirectRules).toEqual([{ source: '/old', destination: '/new', status: 301 }]);
    expect(imported.prerender).toEqual(['/old']);
    expect(imported.warnings).toContain(
      'Skipping Nuxt routeRules proxy entries; implement proxies in app server handlers.',
    );
  });

  it('lets config rules replace imported rules for the same pattern and kind', () => {
    const merged = mergeStructuredRevalidate(
      [{ pattern: '/api/*', ttl: 60, kind: 'api', source: 'framework' }],
      [{ pattern: '/api/*', ttl: 0, kind: 'api' }],
    );
    expect(merged).toEqual([
      { pattern: '/api/*', ttl: 0, query: false, kind: 'api', source: 'config' },
    ]);
  });

  it('preserves Nuxt ISR, SWR, and cache opt-out rules', () => {
    setup({
      '/blog/**': { isr: 60 },
      '/blog/private/**': { isr: false },
      '/blog/preview/**': { isr: 0 },
      '/swr/private/**': { swr: false },
      '/swr/preview/**': { swr: 0 },
      '/cache/private/**': { cache: false },
      '/cache/preview/**': { cache: { maxAge: 0 } },
    });

    const imported = importNuxtRouteRules(tmpDir);
    expect(imported.revalidate).toContainEqual({
      pattern: '/blog/private/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
    expect(imported.revalidate).toContainEqual({
      pattern: '/blog/preview/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
    expect(imported.revalidate).toContainEqual({
      pattern: '/swr/private/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
    expect(imported.revalidate).toContainEqual({
      pattern: '/swr/preview/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
    expect(imported.revalidate).toContainEqual({
      pattern: '/cache/private/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
    expect(imported.revalidate).toContainEqual({
      pattern: '/cache/preview/*',
      ttl: 0,
      query: false,
      kind: 'page',
      source: 'framework',
    });
  });

  it('lets numeric config zero disable imported framework ISR', () => {
    const merged = mergeStructuredRevalidate(
      [{ pattern: '/blog/*', ttl: 60, kind: 'page', source: 'framework' }],
      0,
    );
    expect(merged).toBe(0);
  });
});
