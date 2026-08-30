/**
 * Unit coverage for the two api-side crypto surfaces `void/email` depends on:
 *
 *   - `auth/confirm-token.ts` — the HMAC token that IS the auth on the public
 *     destination-confirmation endpoint.
 *   - `email/send-verification.ts` — the content-bound HMAC the proxy's
 *     `POST /email/internal/send` requires:
 *     `sentinel.unixSeconds.sha256(from|to|mimeBase64)`.
 *
 * The api SIGNS and the proxy VERIFIES, in two separately-bundled workers, so
 * the contract needs a test that runs both. That test lives on the proxy side
 * (`packages/proxy/test/unit/email-platform-token.test.ts`): importing the
 * proxy entry from here would drag `proxy/src/ai.ts` into the api typecheck,
 * which runs with the default lib for Miniflare's DOM-compatible `URL` types
 * and cannot compile the worker sources. What stays here is the api's own
 * half — what it signs, and the mirrored sentinel it signs with.
 */

import { describe, expect, it, vi } from 'vite-plus/test';
import { signConfirmToken, verifyConfirmToken } from '../../src/auth/confirm-token.ts';
import {
  hashSendContent,
  PLATFORM_INTERNAL_EMAIL_SENTINEL,
  sendPlatformVerificationEmail,
} from '../../src/email/send-verification.ts';
import type { ApiEnv } from '../../src/env.ts';

const SECRET = 'test-platform-secret';

/**
 * The platform mail zone is a per-environment var, never a baked-in literal.
 * Staging's value here on purpose: a test pinned to production's domain would
 * pass against code that ignored the var entirely.
 */
const MAIL_DOMAIN = 'mail.staging.void.cloud';

const DAY = 24 * 60 * 60;

function payload(overrides: Partial<Parameters<typeof signConfirmToken>[0]> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1 as const,
    pid: 'proj_x',
    did: 'edst_x',
    addr: 'a@b.com',
    iat: now,
    exp: now + DAY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// confirm-token
// ---------------------------------------------------------------------------

describe('signConfirmToken / verifyConfirmToken', () => {
  it('round-trips a well-formed payload', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload({ iat: now, exp: now + DAY }), SECRET);
    const decoded = await verifyConfirmToken(token, SECRET, now);
    expect(decoded).toMatchObject({ v: 1, pid: 'proj_x', did: 'edst_x', addr: 'a@b.com' });
  });

  it('rejects a token signed with a different secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload(), 'some-other-secret');
    expect(await verifyConfirmToken(token, SECRET, now)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // Re-encode the payload with a different destination id but keep the
    // original signature — the classic "confirm someone else's row" attempt.
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload(), SECRET);
    const [body, sig] = token.split('.');
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(body!.replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
          ch.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
    decoded.did = 'edst_someone_else';
    const reencoded = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await verifyConfirmToken(`${reencoded}.${sig}`, SECRET, now)).toBeNull();
  });

  it.each([
    ['no separator', 'notatoken'],
    ['three parts', 'a.b.c'],
    ['empty signature', 'abc.'],
    ['empty body', '.abc'],
  ])('rejects a structurally invalid token (%s)', async (_label, token) => {
    expect(await verifyConfirmToken(token, SECRET)).toBeNull();
  });

  it('rejects a payload with the wrong schema version', async () => {
    const now = Math.floor(Date.now() / 1000);
    // A future v2 token must not be accepted by a v1 verifier — the whole
    // point of the version field is that a shape change invalidates old links.
    const token = await signConfirmToken(
      { ...payload(), v: 2 } as unknown as Parameters<typeof signConfirmToken>[0],
      SECRET,
    );
    expect(await verifyConfirmToken(token, SECRET, now)).toBeNull();
  });

  it('rejects an expired token, including exactly at exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signConfirmToken(payload({ iat: now - DAY, exp: now - 1 }), SECRET);
    expect(await verifyConfirmToken(expired, SECRET, now)).toBeNull();

    // `exp <= now` — the boundary second is already dead.
    const atBoundary = await signConfirmToken(payload({ iat: now - DAY, exp: now }), SECRET);
    expect(await verifyConfirmToken(atBoundary, SECRET, now)).toBeNull();

    // One second of life left.
    const alive = await signConfirmToken(payload({ iat: now - DAY, exp: now + 1 }), SECRET);
    expect(await verifyConfirmToken(alive, SECRET, now)).not.toBeNull();
  });

  it('accepts an iat up to 60s in the future (clock skew between workers)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload({ iat: now + 30, exp: now + DAY }), SECRET);
    const decoded = await verifyConfirmToken(token, SECRET, now);
    expect(decoded).not.toBeNull();
    expect(decoded?.iat).toBe(now + 30);
  });

  it('rejects an iat past the 60s skew tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 61s: the boundary. Anything beyond it is a forged token or an issuing
    // worker whose clock is wrong enough that its tokens should not be honored.
    const atBoundary = await signConfirmToken(payload({ iat: now + 61, exp: now + DAY }), SECRET);
    expect(await verifyConfirmToken(atBoundary, SECRET, now)).toBeNull();

    const wayOut = await signConfirmToken(payload({ iat: now + 5 * 60, exp: now + DAY }), SECRET);
    expect(await verifyConfirmToken(wayOut, SECRET, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hashSendContent
// ---------------------------------------------------------------------------

describe('hashSendContent', () => {
  const FROM = `noreply@${MAIL_DOMAIN}`;

  it('is a stable lowercase hex SHA-256', async () => {
    const h = await hashSendContent(FROM, 'user@example.com', 'AAAA');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSendContent(FROM, 'user@example.com', 'AAAA')).toBe(h);
  });

  it('changes when any of the three bound fields changes', async () => {
    const base = await hashSendContent(FROM, 'user@example.com', 'AAAA');
    expect(await hashSendContent(`noreply@mail.void.cloud`, 'user@example.com', 'AAAA')).not.toBe(
      base,
    );
    expect(await hashSendContent(FROM, 'other@example.com', 'AAAA')).not.toBe(base);
    expect(await hashSendContent(FROM, 'user@example.com', 'AAAB')).not.toBe(base);
  });

  it('does not case-fold its inputs', async () => {
    // The proxy recomputes the hash from the body VERBATIM, so the api must
    // hash exactly what it puts on the wire — any normalization here would
    // have to be mirrored there or every send would 403.
    const lower = await hashSendContent('a@b.com', 'c@d.com', 'mime');
    expect(await hashSendContent('A@B.com', 'c@d.com', 'mime')).not.toBe(lower);
    expect(await hashSendContent('a@b.com', 'C@D.com', 'mime')).not.toBe(lower);
  });

  it('is not blindly concatenation-collidable across the `|` separator', async () => {
    // `a|b|c` must not hash the same as a shifted split of the same bytes.
    // No legal address or base64 character is `|`, which is why the separator
    // is safe — this pins that the fields are actually separated at all.
    const a = await hashSendContent('x@y.com', 'p@q.com', 'MIME');
    const b = await hashSendContent('x@y.com|p@q.com', '', 'MIME');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// api -> proxy: the real signer against the real verifier
// ---------------------------------------------------------------------------

describe('platform-internal send: what the api signs', () => {
  type CapturedSend = {
    url: string;
    body: {
      platformToken: string;
      platformTimestamp: number;
      from: string;
      to: string;
      mimeBase64: string;
    };
  };

  /**
   * Run the REAL api sender with `fetch` stubbed, and hand back the exact
   * request body it would have POSTed to the proxy.
   */
  async function captureApiSend(
    overrides: Partial<ApiEnv['Bindings']> = {},
  ): Promise<CapturedSend> {
    const calls: Array<CapturedSend> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }),
    );
    try {
      await sendPlatformVerificationEmail(
        {
          JWT_SECRET: SECRET,
          EMAIL_SENDER_DOMAIN: MAIL_DOMAIN,
          ...overrides,
        } as unknown as ApiEnv['Bindings'],
        { id: 'proj_1', slug: 'acme' },
        'recipient@example.com',
        'confirm-token-value',
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  it('posts to the proxy with the configured sender and the full token tuple', async () => {
    const send = await captureApiSend();
    expect(send.url).toMatch(/\/email\/internal\/send$/);
    // Derived from EMAIL_SENDER_DOMAIN, not a literal.
    expect(send.body.from).toBe(`noreply@${MAIL_DOMAIN}`);
    expect(send.body.to).toBe('recipient@example.com');
    expect(typeof send.body.platformToken).toBe('string');
    expect(typeof send.body.platformTimestamp).toBe('number');
    expect(Math.abs(Math.floor(Date.now() / 1000) - send.body.platformTimestamp)).toBeLessThan(60);
    // The signed hash is over the mime the proxy will actually be handed.
    const mime = new TextDecoder().decode(
      Uint8Array.from(atob(send.body.mimeBase64), (ch) => ch.charCodeAt(0)),
    );
    expect(mime).toContain(`From: noreply@${MAIL_DOMAIN}`);
    expect(mime).toContain('To: recipient@example.com');
    expect(mime).toContain('/email/destinations/confirm?token=confirm-token-value');
  });

  it('throws rather than sending when EMAIL_SENDER_DOMAIN is unset', async () => {
    // Nothing is defaulted: a fallback to the production zone would sign mail
    // for a domain a staging worker has no business sending from, and the
    // proxy would 403 it anyway — turning a config error into a silent
    // per-send failure.
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    try {
      await expect(
        sendPlatformVerificationEmail(
          { JWT_SECRET: SECRET } as unknown as ApiEnv['Bindings'],
          { id: 'proj_1', slug: 'acme' },
          'recipient@example.com',
          'tok',
        ),
      ).rejects.toThrow(/EMAIL_SENDER_DOMAIN/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it('the sentinel literal is the one the proxy mirrors', async () => {
    // The proxy cannot import from `packages/api`, so it re-declares the
    // string. A rename on one side only would 403 every platform send.
    expect(PLATFORM_INTERNAL_EMAIL_SENTINEL).toBe('void-platform-internal-email-v1');
    const proxySource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../../proxy/src/index.ts', import.meta.url).pathname, 'utf8'),
    );
    expect(proxySource).toContain(`'${PLATFORM_INTERNAL_EMAIL_SENTINEL}'`);
  });
});
