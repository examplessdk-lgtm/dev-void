import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { hash as blake3hash } from 'blake3-jit';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  computeAssetHash,
  collectAndHashAssets,
  resolveSpaFallbackChain,
} from '../../src/cli/package.ts';

const TMP = join(import.meta.dirname, '.tmp-package-test');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
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
