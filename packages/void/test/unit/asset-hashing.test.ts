import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getContentType } from '@void/edge';
import { hash as blake3hash } from 'blake3-jit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `vi.mock` is hoisted above all imports — declare the mock before importing
// `node:fs` consumers so the spy is in place when `package.ts` resolves its
// `import { readFileSync } from 'node:fs'` binding. We re-export every other
// member of the real module via `actual` so existsSync/readdirSync etc.
// continue to work end-to-end against the temp directory.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const fsModule = await import('node:fs');
const readFileSyncMock = fsModule.readFileSync as unknown as ReturnType<typeof vi.fn>;

const { collectAndHashAssets, computeAssetHash, computeAssetHashes, computeMd5 } =
  await import('../../src/cli/package.ts');

const TMP = join(import.meta.dirname, '.tmp-asset-hashing-test');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  readFileSyncMock.mockClear();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('computeMd5', () => {
  it('matches Node crypto.createHash("md5") for raw bytes', () => {
    // Sanity: empty string MD5 is the well-known constant.
    expect(computeMd5(Buffer.from(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('returns 32 lowercase hex chars', () => {
    const md5 = computeMd5(Buffer.from('something'));
    expect(md5).toHaveLength(32);
    expect(md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes raw content (not base64+ext)', () => {
    // MD5 must operate on raw bytes — independent of any extension/base64
    // wrapping that BLAKE3 uses. Pin a known fixture.
    expect(computeMd5(Buffer.from('hello\n'))).toBe('b1946ac92492d2347c6235b4d2611184');
  });
});

describe('computeAssetHashes', () => {
  it('returns both BLAKE3 and MD5 for known fixtures', () => {
    // Fixture: file content "hello\n" with extension "js".
    // Expected values pinned from a fresh local computation against
    // blake3-jit and node:crypto md5.
    const content = Buffer.from('hello\n');
    const filePath = 'test.js';
    const { blake3, md5 } = computeAssetHashes(content, filePath);
    expect(blake3).toBe('dc6c72af24e164d6188743458a7da473');
    expect(md5).toBe('b1946ac92492d2347c6235b4d2611184');
  });

  it('matches the standalone computeAssetHash + computeMd5 outputs', () => {
    const content = Buffer.from('some asset bytes');
    const filePath = 'foo/bar.css';
    const both = computeAssetHashes(content, filePath);
    expect(both.blake3).toBe(computeAssetHash(content, filePath));
    expect(both.md5).toBe(computeMd5(content));
  });
});

describe('BLAKE3 wire compatibility', () => {
  it('matches Wrangler\'s hashFile output for "const x = 1;\\n" / .js', () => {
    // Regression test for the existing CF-compatible recipe:
    //   blake3(base64(content) + extension).hex().slice(0, 32)
    // Bit-for-bit compatible with workers-sdk's pages/hash.ts:hashFile.
    const content = Buffer.from('const x = 1;\n');
    const filePath = 'foo.js';

    // Direct computation (independent of computeAssetHash) to lock the
    // algorithm in place even if the helper changes shape.
    const base64 = content.toString('base64');
    const ext = 'js';
    const input = new TextEncoder().encode(base64 + ext);
    const expected = Buffer.from(blake3hash(input)).toString('hex').slice(0, 32);

    expect(expected).toBe('3725f96aa779d1959d5942b1b4e04567');
    expect(computeAssetHash(content, filePath)).toBe(expected);
    expect(computeAssetHashes(content, filePath).blake3).toBe(expected);
  });
});

describe('collectAndHashAssets — v2 manifest entries', () => {
  it('emits { blake3, md5, size, hash } per entry', async () => {
    writeFileSync(join(TMP, 'a.js'), 'hello\n');

    const { assetManifest } = await collectAndHashAssets(TMP);

    const entry = assetManifest['/a.js'];
    expect(entry).toBeDefined();
    expect(entry.blake3).toBe('dc6c72af24e164d6188743458a7da473');
    expect(entry.md5).toBe('b1946ac92492d2347c6235b4d2611184');
    expect(entry.size).toBe(Buffer.from('hello\n').length);
    // Deprecated v1 alias — must equal blake3 for one release so existing
    // consumers reading entry.hash keep working.
    expect(entry.hash).toBe(entry.blake3);
  });

  it('reads each file from disk exactly once', async () => {
    writeFileSync(join(TMP, 'a.js'), 'one');
    writeFileSync(join(TMP, 'b.css'), 'two');
    writeFileSync(join(TMP, 'c.html'), 'three');

    // Mock state was cleared in beforeEach; collectAndHashAssets is the only
    // call into readFileSync from this point. The mocked fn delegates to the
    // real implementation so file content still flows through correctly.
    const { assetManifest } = await collectAndHashAssets(TMP);

    // Filter mock calls to just the assets we wrote (createAssetsIgnoreFunction
    // does NOT readFileSync .assetsignore unless it exists, but be defensive).
    const assetReads = readFileSyncMock.mock.calls.filter(([p]: Array<unknown>) => {
      const path = String(p);
      return path.endsWith('a.js') || path.endsWith('b.css') || path.endsWith('c.html');
    });
    expect(assetReads).toHaveLength(3);
    // No duplicate path should appear twice — proves single-pass.
    const paths = assetReads.map(([p]: Array<unknown>) => String(p));
    expect(new Set(paths).size).toBe(3);

    // Manifest should still be populated correctly (sanity).
    expect(Object.keys(assetManifest).sort()).toEqual(['/a.js', '/b.css', '/c.html']);
  });
});

describe('asset upload content type', () => {
  it('returns text/markdown for .md files', () => {
    expect(getContentType('/guide/github-actions-cache.md')).toBe('text/markdown; charset=utf-8');
  });

  it('returns text/markdown for .markdown files', () => {
    expect(getContentType('/notes.markdown')).toBe('text/markdown; charset=utf-8');
  });

  it('returns text/yaml for .yaml and .yml files', () => {
    expect(getContentType('/config.yaml')).toBe('text/yaml; charset=utf-8');
    expect(getContentType('/config.yml')).toBe('text/yaml; charset=utf-8');
  });

  it('returns application/toml for .toml files', () => {
    expect(getContentType('/config.toml')).toBe('application/toml');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(getContentType('/file.xyz')).toBe('application/octet-stream');
  });
});
