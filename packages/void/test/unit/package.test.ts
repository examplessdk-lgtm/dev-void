import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hash as blake3hash } from 'blake3-jit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  packageBuild,
  packageStaticBuild,
  packageFrameworkBuild,
  computeAssetHash,
  collectAndHashAssets,
  resolveSpaFallbackChain,
} from '../../src/cli/package';

const TMP = join(import.meta.dirname, '.tmp-package-test');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('packageStaticBuild', () => {
  it('includes all assets in form data', async () => {
    writeFileSync(join(TMP, 'a.html'), 'a');
    writeFileSync(join(TMP, 'b.js'), 'b');

    const form = await packageStaticBuild(TMP, 'spa');

    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }

    expect(assetKeys.sort()).toEqual(['a.html', 'b.js']);
  });

  it('sets version 2 in manifest', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const form = await packageStaticBuild(TMP, 'spa');

    const manifestRaw = form.get('manifest') as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(3);
  });

  it('sets assetConfig for SPA mode', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const form = await packageStaticBuild(TMP, 'spa');

    const manifestRaw = form.get('manifest') as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: 'single-page-application',
    });
  });

  it('sets assetConfig for static mode', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const form = await packageStaticBuild(TMP, 'static');

    const manifestRaw = form.get('manifest') as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: '404-page',
    });
  });

  it('keeps platform-level SPA fallback when no routing.fallbacks are configured', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const form = await packageStaticBuild(TMP, 'spa');

    const manifest = JSON.parse(form.get('manifest') as string);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: 'single-page-application',
    });
    expect(manifest.fallbackRules).toBeUndefined();
  });

  it('disables platform SPA switch and prepends synthetic /* -> /index.html when user fallbacks exist', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const userFallbacks = [
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ];
    const form = await packageStaticBuild(
      TMP,
      'spa',
      undefined,
      undefined,
      undefined,
      undefined,
      userFallbacks,
    );

    const manifest = JSON.parse(form.get('manifest') as string);
    expect(manifest.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(manifest.fallbackRules).toEqual([
      { source: '/*', destination: '/index.html', status: 200 },
      { source: '/docs/*', destination: '/docs.html', status: 200 },
    ]);
  });

  it('passes through user fallbacks unchanged for non-SPA static app type', async () => {
    writeFileSync(join(TMP, 'index.html'), 'x');

    const userFallbacks = [
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ];
    const form = await packageStaticBuild(
      TMP,
      'static',
      undefined,
      undefined,
      undefined,
      undefined,
      userFallbacks,
    );

    const manifest = JSON.parse(form.get('manifest') as string);
    expect(manifest.assetConfig).toEqual({ not_found_handling: '404-page' });
    expect(manifest.fallbackRules).toEqual([
      { source: '/docs/*', destination: '/docs.html', status: 200 },
    ]);
  });
});

describe('resolveSpaFallbackChain', () => {
  it('returns SPA platform switch with no rules when user has no fallbacks (SPA)', () => {
    const result = resolveSpaFallbackChain('spa', undefined);
    expect(result.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(result.fallbackRules).toBeUndefined();
  });

  it('prepends synthetic catch-all before user fallbacks (SPA)', () => {
    const userRules = [{ source: '/docs/*', destination: '/docs.html', status: 200, force: false }];
    const result = resolveSpaFallbackChain('spa', userRules);
    expect(result.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(result.fallbackRules).toEqual([
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ]);
  });

  it('returns the user rules verbatim (no prepend, no duplication) when user already has /* -> /index.html', () => {
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

describe('packageBuild', () => {
  it('excludes .vite/ directory from worker files', async () => {
    // Set up dist/worker/ with worker files and .vite/manifest.json
    const workerDir = join(TMP, 'worker');
    mkdirSync(join(workerDir, '.vite'), { recursive: true });
    mkdirSync(join(workerDir, 'assets'), { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');
    writeFileSync(join(workerDir, 'assets', 'chunk.js'), 'var x = 1');
    writeFileSync(join(workerDir, '.vite', 'manifest.json'), '{"key":"value"}');

    const form = await packageBuild(TMP, 'worker', {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const workerKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('worker:')) {
        workerKeys.push(key.slice('worker:'.length));
      }
    }

    expect(workerKeys.sort()).toEqual(['assets/chunk.js', 'index.js']);
    expect(workerKeys).not.toContain('.vite/manifest.json');
  });

  it('sets version 2 in manifest', async () => {
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const form = await packageBuild(TMP, 'worker', {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const manifestRaw = form.get('manifest') as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(3);
  });

  it('marks auth-enabled deploys in the manifest', async () => {
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const form = await packageBuild(TMP, 'worker', {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: true,
      needsQueues: false,
      needsAI: false,
    });

    const manifestRaw = form.get('manifest') as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.auth).toBe(true);
  });

  it('layers user fallbacks with SPA default when not_found_handling is single-page-application', async () => {
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const userFallbacks = [
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ];
    const form = await packageBuild(
      TMP,
      'worker',
      {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      },
      undefined, // migrations
      undefined, // schedules
      undefined, // ssr
      undefined, // framework
      undefined, // revalidate
      undefined, // vars
      undefined, // queues
      undefined, // prerender
      { not_found_handling: 'single-page-application' },
      undefined, // options
      undefined, // neededAssets
      undefined, // hashedAssetsPrefix
      undefined, // headerRules
      undefined, // redirectRules
      userFallbacks,
    );

    const manifest = JSON.parse(form.get('manifest') as string);
    expect(manifest.assetConfig).toEqual({ not_found_handling: 'none' });
    expect(manifest.fallbackRules).toEqual([
      { source: '/*', destination: '/index.html', status: 200 },
      { source: '/docs/*', destination: '/docs.html', status: 200 },
    ]);
  });

  it('warns when routing.fallbacks is set on a non-SPA (SSR) packageBuild', async () => {
    // On SSR / Void / framework apps, user fallbacks still fire post-lookup,
    // but no `/* -> /index.html` SPA shell is synthesised. Surface the
    // mismatch at build time so users don't silently ship fallbacks that
    // won't save them from the platform 404.
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const userFallbacks = [
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await packageBuild(
      TMP,
      'worker',
      {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      },
      undefined, // migrations
      undefined, // schedules
      true, // ssr
      undefined, // framework
      undefined, // revalidate
      undefined, // vars
      undefined, // queues
      undefined, // prerender
      undefined, // assetConfig — no SPA signal, so the SSR branch fires
      undefined, // options
      undefined, // neededAssets
      undefined, // hashedAssetsPrefix
      undefined, // headerRules
      undefined, // redirectRules
      userFallbacks,
    );

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          m.includes('routing.fallbacks is set but appType is not "spa"') &&
          m.includes('no "/* -> /index.html" SPA shell fallback is synthesised'),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it('does not warn about the SPA shell when fallbacks are paired with the SPA asset config', async () => {
    // Regression anchor: the SSR warning must only fire when
    // `not_found_handling !== 'single-page-application'`. On SPA the
    // resolveSpaFallbackChain path runs instead (and has its own warnings).
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const userFallbacks = [
      { source: '/docs/*', destination: '/docs.html', status: 200, force: false },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await packageBuild(
      TMP,
      'worker',
      {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      },
      undefined, // migrations
      undefined, // schedules
      undefined, // ssr
      undefined, // framework
      undefined, // revalidate
      undefined, // vars
      undefined, // queues
      undefined, // prerender
      { not_found_handling: 'single-page-application' },
      undefined, // options
      undefined, // neededAssets
      undefined, // hashedAssetsPrefix
      undefined, // headerRules
      undefined, // redirectRules
      userFallbacks,
    );

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('appType is not "spa"'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('leaves SPA platform switch in place when no user fallbacks exist', async () => {
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');

    const form = await packageBuild(
      TMP,
      'worker',
      {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { not_found_handling: 'single-page-application' },
    );

    const manifest = JSON.parse(form.get('manifest') as string);
    expect(manifest.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(manifest.fallbackRules).toBeUndefined();
  });
});

describe('packageFrameworkBuild', () => {
  it('strips dev-only origin and force metadata from redirectRules and fallbackRules in the manifest', async () => {
    const workerDir = join(TMP, 'server');
    const assetsDir = join(TMP, 'public');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');
    writeFileSync(join(assetsDir, 'index.html'), '<html></html>');

    const redirectRules = [
      {
        source: '/old',
        destination: '/new',
        status: 301,
        force: false,
        origin: '_redirects:12',
      },
      {
        source: '/api/old',
        destination: '/api/new',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ];
    const fallbackRules = [
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'spa-default',
      },
      {
        source: '/docs/*',
        destination: '/docs.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ];

    const form = await packageFrameworkBuild({
      frameworkName: 'test',
      workerDir,
      workerMain: 'index.js',
      assetsDir,
      bindings: {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      },
      redirectRules,
      fallbackRules,
    });

    const manifest = JSON.parse(form.get('manifest') as string);

    expect(manifest.redirectRules).toEqual([
      { source: '/old', destination: '/new', status: 301 },
      { source: '/api/old', destination: '/api/new', status: 200 },
    ]);
    for (const rule of manifest.redirectRules) {
      expect(rule).not.toHaveProperty('origin');
      expect(rule).not.toHaveProperty('force');
    }

    expect(manifest.fallbackRules).toEqual([
      { source: '/*', destination: '/index.html', status: 200 },
      { source: '/docs/*', destination: '/docs.html', status: 200 },
    ]);
    for (const rule of manifest.fallbackRules) {
      expect(rule).not.toHaveProperty('origin');
      expect(rule).not.toHaveProperty('force');
    }
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

describe('packageStaticBuild with neededAssets', () => {
  it('only includes needed assets when set is provided', async () => {
    writeFileSync(join(TMP, 'a.html'), 'a');
    writeFileSync(join(TMP, 'b.js'), 'b');
    writeFileSync(join(TMP, 'c.css'), 'c');

    const needed = new Set(['/a.html', '/c.css']);
    const form = await packageStaticBuild(TMP, 'spa', needed);

    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }

    expect(assetKeys.sort()).toEqual(['a.html', 'c.css']);
    expect(form.get('preflight')).toBe('true');
  });

  it('includes all assets when neededAssets is null', async () => {
    writeFileSync(join(TMP, 'a.html'), 'a');
    writeFileSync(join(TMP, 'b.js'), 'b');

    const form = await packageStaticBuild(TMP, 'spa', null);

    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }

    expect(assetKeys.sort()).toEqual(['a.html', 'b.js']);
    expect(form.get('preflight')).toBeNull();
  });
});

describe('packageStaticBuild asset exclusion', () => {
  it('excludes _headers and _redirects from packaged assets', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, 'app.js'), 'console.log()');
    writeFileSync(join(TMP, '_headers'), '/* X-Test: 1');
    writeFileSync(join(TMP, '_redirects'), '/old /new 301');

    const form = await packageStaticBuild(TMP, 'static');

    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }

    expect(assetKeys.sort()).toEqual(['app.js', 'index.html']);
  });
});

describe('_worker.js safety guard', () => {
  it('throws when _worker.js file exists without .assetsignore', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');

    await expect(packageStaticBuild(TMP, 'static')).rejects.toThrow(
      'Uploading _worker.js file as an asset',
    );
  });

  it('throws when _worker.js directory exists without .assetsignore', async () => {
    mkdirSync(join(TMP, '_worker.js'), { recursive: true });
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js', 'index.js'), 'export default {}');

    await expect(packageStaticBuild(TMP, 'static')).rejects.toThrow(
      'Uploading _worker.js directory as an asset',
    );
  });

  it('allows _worker.js when .assetsignore exists (even if empty)', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '');

    // Does not throw — .assetsignore presence means the user is aware
    const form = await packageStaticBuild(TMP, 'static');
    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }
    // _worker.js is included because .assetsignore doesn't exclude it
    expect(assetKeys).toContain('_worker.js');
  });

  it('excludes _worker.js when .assetsignore lists it', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');
    writeFileSync(join(TMP, '.assetsignore'), '_worker.js');

    const form = await packageStaticBuild(TMP, 'static');
    const assetKeys: Array<string> = [];
    for (const [key] of form.entries()) {
      if (key.startsWith('asset:')) {
        assetKeys.push(key.slice('asset:'.length));
      }
    }
    expect(assetKeys).not.toContain('_worker.js');
    expect(assetKeys).toContain('index.html');
  });

  it('guards collectAndHashAssets against _worker.js too', async () => {
    writeFileSync(join(TMP, 'index.html'), '<html></html>');
    writeFileSync(join(TMP, '_worker.js'), 'export default {}');

    await expect(collectAndHashAssets(TMP)).rejects.toThrow(
      'Uploading _worker.js file as an asset',
    );
  });

  it('guards packageBuild client assets against _worker.js', async () => {
    // Set up worker dir so packageBuild doesn't fail
    const workerDir = join(TMP, 'worker');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');
    // Put _worker.js in client dir
    const clientDir = join(TMP, 'client');
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, 'index.html'), '<html></html>');
    writeFileSync(join(clientDir, '_worker.js'), 'export default {}');

    await expect(
      packageBuild(TMP, 'worker', {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
      }),
    ).rejects.toThrow('Uploading _worker.js file as an asset');
  });

  it('guards packageFrameworkBuild assets against _worker.js', async () => {
    const workerDir = join(TMP, 'server');
    const assetsDir = join(TMP, 'public');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.js'), 'export default {}');
    writeFileSync(join(assetsDir, 'index.html'), '<html></html>');
    writeFileSync(join(assetsDir, '_worker.js'), 'export default {}');

    await expect(
      packageFrameworkBuild({
        frameworkName: 'test',
        workerDir,
        workerMain: 'index.js',
        assetsDir,
        bindings: {
          needsD1: false,
          needsKV: false,
          needsR2: false,
          needsAuth: false,
          needsQueues: false,
          needsAI: false,
        },
      }),
    ).rejects.toThrow('Uploading _worker.js file as an asset');
  });
});
