import { describe, it, expect } from 'vite-plus/test';
import { verifyGithubWebhookSignature } from '../../src/github/webhook-verify.ts';

const SECRET = 'webhook-secret-shhh';

const encoder = new TextEncoder();

// Compute the expected `sha256=<hex>` header the same way GitHub does, using
// WebCrypto directly so the test is independent of the implementation.
async function computeSignature(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('verifyGithubWebhookSignature', () => {
  const body = JSON.stringify({ action: 'push', ref: 'refs/heads/main' });

  it('returns true for a valid signature', async () => {
    const header = await computeSignature(body, SECRET);
    expect(await verifyGithubWebhookSignature(body, header, SECRET)).toBe(true);
  });

  it('returns false when the body is tampered', async () => {
    const header = await computeSignature(body, SECRET);
    const tampered = body.replace('main', 'evil');
    expect(await verifyGithubWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  it('returns false for the wrong secret', async () => {
    const header = await computeSignature(body, SECRET);
    expect(await verifyGithubWebhookSignature(body, header, 'wrong-secret')).toBe(false);
  });

  it('returns false for a missing header', async () => {
    expect(await verifyGithubWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it('returns false for a header missing the sha256= prefix', async () => {
    const header = await computeSignature(body, SECRET);
    const noPrefix = header.slice('sha256='.length);
    expect(await verifyGithubWebhookSignature(body, noPrefix, SECRET)).toBe(false);
  });

  it('returns false for a malformed (non-hex / odd-length) signature', async () => {
    expect(await verifyGithubWebhookSignature(body, 'sha256=zzzz', SECRET)).toBe(false);
    expect(await verifyGithubWebhookSignature(body, 'sha256=abc', SECRET)).toBe(false);
    expect(await verifyGithubWebhookSignature(body, 'sha256=', SECRET)).toBe(false);
  });
});
