import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { hash as blake3hash } from 'blake3-jit';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  buildVoidManifest,
  computeAssetHash,
  collectAndHashAssets,
  collectWorkerFiles,
  resolveSpaFallbackChain,
} from '../../src/cli/package.ts';
import type { VoidConfig } from '../../src/config.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';
import { collectRevalidate } from '../../src/isr-config.ts';
import type { PageDefinition, PageScanResult } from '../../src/pages/types.ts';

const TMP = join(import.meta.dirname, '.tmp-package-test');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(join(import.meta.dirname, 'outside-secret.txt'), { force: true });
});

describe('worker packaging', () => {
  it('keeps the manifest workerMain aligned with uploaded worker modules', () => {
    writeFileSync(join(TMP, 'index.mjs'), 'export default { fetch() {} };');
    writeFileSync(join(TMP, 'index.js.map'), '{}');
    writeFileSync(join(TMP, 'wrangler.json'), JSON.stringify({ main: 'index.mjs' }));

    const manifest = buildVoidManifest({
      bindings: {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
        needsSandbox: false,
      },
      ssr: true,
      options: {
        workerMain: 'index.mjs',
      },
    });
    const workerFiles = collectWorkerFiles(TMP);

    expect(manifest.workerMain).toBe('index.mjs');
    expect(workerFiles.has(manifest.workerMain!)).toBe(true);
    expect(workerFiles.has('wrangler.json')).toBe(false);
  });
});

// Non-regression: the managed `void deploy` manifest must stay byte-identical
// after the self-host AI + ISR refactors (Tasks 2 & 5). These assert the manifest
// builder still sets `bindings.ai` from `needsAI` and still carries the exact
// `collectRevalidate` output the deploy path feeds it.
describe('buildVoidManifest — self-host non-regression', () => {
  function makeBindings(overrides: Partial<InferredBindings> = {}): InferredBindings {
    return {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
      needsSandbox: false,
      ...overrides,
    };
  }

  function makePage(pattern: string, revalidate?: number): PageDefinition {
    return {
      pattern,
      params: [],
      catchAll: false,
      componentPath: `${pattern}.vue`,
      serverPath: `${pattern}.server.ts`,
      methods: ['GET'],
      componentId: pattern.replace(/^\//, ''),
      revalidate,
      ssrMode: 'auto',
      prerenderMode: 'auto',
      renderMode: 'server',
      shouldPrerender: false,
    };
  }

  function makeScan(pages: Array<PageDefinition>): PageScanResult {
    return { pages, layouts: [], namedLayouts: [] };
  }

  function configWith(revalidate: number | Record<string, number> | undefined): VoidConfig {
    return (revalidate === undefined ? {} : { routing: { revalidate } }) as VoidConfig;
  }

  it('sets bindings.ai === true when the app needs Workers AI', () => {
    const manifest = buildVoidManifest({ bindings: makeBindings({ needsAI: true }) });
    expect(manifest.bindings.ai).toBe(true);
  });

  it('omits bindings.ai when the app does not use Workers AI', () => {
    const manifest = buildVoidManifest({ bindings: makeBindings({ needsAI: false }) });
    expect(manifest.bindings.ai).toBeUndefined();
  });

  it('carries collectRevalidate output verbatim into manifest.revalidate (numeric config + per-page)', () => {
    // Same inputs the deploy path feeds: void.json config + page-scan per-page rules.
    const config = configWith(60);
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const revalidate = collectRevalidate(config, scan);

    const manifest = buildVoidManifest({ bindings: makeBindings(), revalidate });

    // Merge must be non-trivial (numeric config → path map with "*" fallback).
    // The single-segment page pattern `/blog/:slug` stays as `/blog/:slug` so the
    // matcher anchors it to ONE path segment (`[^/]+`) at runtime.
    expect(revalidate).toEqual({ '/blog/:slug': 120, '*': 60 });
    // …and it must land in the manifest byte-for-byte.
    expect(manifest.revalidate).toEqual(revalidate);
    expect(Object.keys(manifest.revalidate as Record<string, number>)).toEqual([
      '/blog/:slug',
      '*',
    ]);
  });

  it('carries collectRevalidate output verbatim into manifest.revalidate (object config + per-page order)', () => {
    const config = configWith({ '/docs/*': 30, '*': 10 });
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const revalidate = collectRevalidate(config, scan);

    const manifest = buildVoidManifest({ bindings: makeBindings(), revalidate });

    expect(manifest.revalidate).toEqual(revalidate);
    // Per-page entries precede config entries (first-match-wins ordering preserved).
    // The per-page `/blog/:slug` pattern stays `/blog/:slug` (single-segment); the
    // user's own `routing.revalidate` literal keys (`/docs/*`, `*`) pass untouched.
    expect(Object.entries(manifest.revalidate as Record<string, number>)).toEqual([
      ['/blog/:slug', 120],
      ['/docs/*', 30],
      ['*', 10],
    ]);
  });

  it('leaves manifest.revalidate unset when collectRevalidate yields nothing', () => {
    const revalidate = collectRevalidate(configWith(undefined), makeScan([]));
    const manifest = buildVoidManifest({ bindings: makeBindings(), revalidate });
    expect(revalidate).toBeUndefined();
    expect(manifest.revalidate).toBeUndefined();
  });
});

describe('resolveSpaFallbackChain', () => {
  it('returns SPA platform switch with no rules when user has no fallbacks (SPA)', () => {
    const result = resolveSpaFallbackChain('spa', undefined);
    expect(result.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(result.fallbackRules).toBeUndefined();
  });

  it('appends synthetic catch-all after user fallbacks (SPA)', () => {
    // Under first-match-wins, user rules must come BEFORE the synthetic
    // catch-all so a more-specific user rule fires first; the synthetic
    // `/*` only catches paths no user rule matched.
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('spa', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
    ]);
  });

  it('returns the user rules verbatim (no append, no duplication) when user already has /* -> /index.html', () => {
    const userRules = [
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const result = resolveSpaFallbackChain('spa', userRules);

    // Platform SPA switch disabled — we're handling the catch-all via rules.
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    // No synthetic rule prepended: the returned list is exactly what the user supplied.
    expect(result.fallbackRules).toEqual(userRules);
  });

  it('still appends synthetic catch-all when user catch-all is host-scoped (SPA)', () => {
    // A host-scoped `/*` -> `/index.html` only covers one hostname, so other
    // bound hosts still need the synthetic global SPA fallback.
    const userRules = [
      {
        host: 'www.example.com',
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];
    const result = resolveSpaFallbackChain('spa', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      ...userRules,
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
    ]);
  });

  it('leaves user fallbacks untouched for static app type', () => {
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('static', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: '404-page' });
    expect(result.fallbackRules).toEqual(userRules);
  });

  it('returns none and undefined rules for undefined app type with no user rules', () => {
    const result = resolveSpaFallbackChain(undefined, undefined);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toBeUndefined();
  });
});

describe('computeAssetHash', () => {
  it('returns a 32-char hex string', () => {
    const hash = computeAssetHash(Buffer.from('hello world'), 'test.html');
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns consistent hashes for same content and path', () => {
    const a = computeAssetHash(Buffer.from('test content'), 'file.js');
    const b = computeAssetHash(Buffer.from('test content'), 'file.js');
    expect(a).toBe(b);
  });

  it('returns different hashes for different content', () => {
    const a = computeAssetHash(Buffer.from('content a'), 'file.js');
    const b = computeAssetHash(Buffer.from('content b'), 'file.js');
    expect(a).not.toBe(b);
  });

  it('returns different hashes for same content with different extensions', () => {
    const content = Buffer.from('identical bytes');
    const hashHtml = computeAssetHash(content, 'file.html');
    const hashJs = computeAssetHash(content, 'file.js');
    const hashNoExt = computeAssetHash(content, 'file');
    expect(hashHtml).not.toBe(hashJs);
    expect(hashHtml).not.toBe(hashNoExt);
    expect(hashJs).not.toBe(hashNoExt);
  });

  it("matches Wrangler's BLAKE3 hash algorithm", () => {
    // Wrangler computes: blake3(base64(content) + extension).hex().slice(0, 32)
    const content = Buffer.from('cross-compat test');
    const filePath = 'test.txt';
    const cliHash = computeAssetHash(content, filePath);

    // Reproduce Wrangler's algorithm directly
    const base64 = content.toString('base64');
    const ext = 'txt';
    const input = new TextEncoder().encode(base64 + ext);
    const digest = blake3hash(input);
    const wranglerHash = Buffer.from(digest).toString('hex').slice(0, 32);

    expect(cliHash).toBe(wranglerHash);
  });

  it('matches API-side hash for same input', () => {
    // The API uses arrayBufferToBase64 + blake3-jit — verify cross-compatibility
    const content = Buffer.from('api compat test');
    const filePath = 'styles.css';
    const cliHash = computeAssetHash(content, filePath);

    // Simulate API-side: ArrayBuffer → base64 via btoa(String.fromCharCode)
    const bytes = new Uint8Array(content);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const apiBase64 = btoa(binary);
    const ext = 'css';
    const input = new TextEncoder().encode(apiBase64 + ext);
    const digest = blake3hash(input);
    const apiHash = [...digest]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(cliHash).toBe(apiHash);
  });
});

describe('collectAndHashAssets', () => {
  it('collects files with hashes and sizes', async () => {
    mkdirSync(join(TMP, 'assets'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html>hello</html>');
    writeFileSync(join(TMP, 'assets', 'app.js'), "console.log('hi')");

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest).sort()).toEqual(['/assets/app.js', '/index.html']);
    expect(assetManifest['/index.html'].hash).toHaveLength(32);
    expect(assetManifest['/index.html'].size).toBe(Buffer.from('<html>hello</html>').length);
    expect(assetFiles.size).toBe(2);
  });

  it('returns empty manifest for missing directory', async () => {
    const { assetManifest, assetFiles } = await collectAndHashAssets(join(TMP, 'nonexistent'));

    expect(Object.keys(assetManifest)).toHaveLength(0);
    expect(assetFiles.size).toBe(0);
  });

  it('excludes _headers, _redirects, and .assetsignore from manifest', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_headers'), '/* X-Frame-Options: DENY');
    writeFileSync(join(TMP, '_redirects'), '/old /new 301');
    writeFileSync(join(TMP, '.assetsignore'), '');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('excludes macOS .DS_Store metadata files from manifest', async () => {
    mkdirSync(join(TMP, 'assets'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '.DS_Store'), 'metadata');
    writeFileSync(join(TMP, 'assets', '.DS_Store'), 'metadata');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('excludes dotenv files from manifest', async () => {
    mkdirSync(join(TMP, 'nested'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '.env.local'), 'SECRET_TOKEN=should-not-be-public');
    writeFileSync(join(TMP, '.env.production.local'), 'PROD_SECRET=should-not-be-public');
    writeFileSync(join(TMP, 'nested', '.env'), 'NESTED_SECRET=should-not-be-public');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('honors custom .assetsignore patterns', async () => {
    mkdirSync(join(TMP, 'secret'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, 'draft.txt'), 'draft');
    writeFileSync(join(TMP, 'secret', 'key.pem'), 'secret');
    writeFileSync(join(TMP, '.assetsignore'), '*.txt\nsecret/');

    const { assetManifest } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
  });
});

describe('_worker.js safety guard (collectAndHashAssets)', () => {
  it('throws when a static asset is a symlink', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload symlink as an asset',
    );
  });

  it('allows symlinks excluded by .assetsignore', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));
    writeFileSync(join(TMP, '.assetsignore'), 'linked-secret.txt');

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('allows symlinks excluded by deploy ignore patterns', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(import.meta.dirname, 'outside-secret.txt'), 'secret');
    symlinkSync('../outside-secret.txt', join(TMP, 'linked-secret.txt'));

    const { assetManifest, assetFiles } = await collectAndHashAssets(TMP, undefined, {
      ignorePatterns: ['/linked-secret.txt'],
    });

    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
    expect(assetFiles.size).toBe(1);
  });

  it('throws when _worker.js file exists without .assetsignore', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload _worker.js file as an asset',
    );
  });

  it('throws when _worker.js directory exists without .assetsignore', async () => {
    mkdirSync(join(TMP, '_worker.js'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js', 'index.js'), 'export default {}');

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'deploy: Refusing to upload _worker.js directory as an asset',
    );
  });

  it('allows _worker.js when .assetsignore exists (even if empty)', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '');

    const { assetManifest } = await collectAndHashAssets(TMP);
    // _worker.js is included because .assetsignore doesn't exclude it
    expect(Object.keys(assetManifest).sort()).toEqual(['/_worker.js', '/index.html']);
  });

  it('excludes _worker.js when .assetsignore lists it', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '_worker.js');

    const { assetManifest } = await collectAndHashAssets(TMP);
    expect(Object.keys(assetManifest)).toEqual(['/index.html']);
  });

  it('lets framework deploys ignore co-located worker control files during preflight', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '_routes.json'), '{}');

    const { assetManifest } = await collectAndHashAssets(TMP, undefined, {
      ignorePatterns: ['/_worker.js', '/_routes.json'],
    });

    expect(Object.keys(assetManifest).sort()).toEqual(['/index.html']);
  });
});
