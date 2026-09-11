import { describe, it, expect } from 'vite-plus/test';
import { presignAssetPut } from '../../src/r2-presign.ts';

const FIXED_NOW = new Date('2026-05-07T12:00:00.000Z');

const BASE_OPTS = {
  accountId: 'acct12345',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  bucket: 'void-static-assets-overflow',
  key: 'assets/proj_abc/dead', // 'dead' stands in for a blake3 prefix
  // MD5 of empty string — the canonical fixture.
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  contentType: 'application/javascript',
  now: FIXED_NOW,
};

describe('presignAssetPut', () => {
  it('returns a URL pointing at the right host, bucket, and key', async () => {
    const out = await presignAssetPut(BASE_OPTS);
    const u = new URL(out.url);
    expect(u.hostname).toBe('acct12345.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/void-static-assets-overflow/assets/proj_abc/dead');
  });

  it('returns headers with Content-Md5 set to base64 of the raw digest', async () => {
    // The known empty-string MD5 hex round-trips to this exact base64.
    const out = await presignAssetPut(BASE_OPTS);
    expect(out.headers['Content-Md5']).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
    expect(out.headers['Content-Type']).toBe('application/javascript');
  });

  it('honors ttlSeconds via X-Amz-Expires query param', async () => {
    const out = await presignAssetPut({ ...BASE_OPTS, ttlSeconds: 1800 });
    const u = new URL(out.url);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('1800');
  });

  it('defaults X-Amz-Expires to 600 when ttlSeconds is omitted', async () => {
    // BASE_OPTS does not set ttlSeconds, so this exercises the default.
    const out = await presignAssetPut(BASE_OPTS);
    const u = new URL(out.url);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('produces deterministic output for fixed inputs and time', async () => {
    const a = await presignAssetPut(BASE_OPTS);
    const b = await presignAssetPut(BASE_OPTS);
    expect(a.url).toBe(b.url);
    expect(a.headers).toEqual(b.headers);
  });

  it('signs the Content-Md5 header so R2 enforces it server-side', async () => {
    const out = await presignAssetPut(BASE_OPTS);
    const u = new URL(out.url);
    const signed = u.searchParams.get('X-Amz-SignedHeaders');
    expect(signed).not.toBeNull();
    const headerNames = (signed ?? '').split(';');
    // AWS V4 canonical form lowercases header names.
    expect(headerNames).toContain('content-md5');
    // Content-Type and host are also covered — the URL is tamper-evident
    // for the full PUT envelope.
    expect(headerNames).toContain('content-type');
    expect(headerNames).toContain('host');
  });
});
