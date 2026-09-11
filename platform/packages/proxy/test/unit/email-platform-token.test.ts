/**
 * The cross-package half of the platform-internal send contract.
 *
 * `packages/api` SIGNS the request (`email/send-verification.ts`) and this
 * worker VERIFIES it (`POST /email/internal/send`). The two are separately
 * bundled and share only `JWT_SECRET`, `EMAIL_SENDER_DOMAIN`, and a mirrored
 * sentinel literal — nothing inside either package's own unit tests can catch
 * a drift between them. So these cases sign with the REAL api code path and
 * verify with the REAL proxy worker.
 *
 * They live on the PROXY side on purpose. The api package typechecks its
 * `test/` directory with the default lib (it needs DOM-compatible `URL` types
 * for Miniflare — see the tsconfig note in the repo README), and the proxy
 * worker's sources do not compile under that lib. Importing the proxy entry
 * from an api test drags `proxy/src/ai.ts` into the api typecheck and breaks
 * it. The api-only half of this contract stays in
 * `packages/api/test/unit/email-platform-token.test.ts`.
 */

import { describe, expect, it, vi } from 'vite-plus/test';
import { sendPlatformVerificationEmail } from '../../../api/src/email/send-verification.ts';

const SECRET = 'test-platform-secret';

/**
 * The platform mail zone is a per-environment var, never a baked-in literal.
 * Staging's value here on purpose: a test pinned to production's domain would
 * pass against code that ignored the var entirely.
 */
const MAIL_DOMAIN = 'mail.staging.void.cloud';

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
 * request body it would have POSTed to this worker.
 */
async function captureApiSend(overrides: Record<string, unknown> = {}): Promise<CapturedSend> {
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
      } as never,
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

function proxyEnv(overrides: Record<string, unknown> = {}) {
  return {
    AI: {},
    JWT_SECRET: SECRET,
    ROUTING: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: vi.fn() },
    DISPATCH: { get: vi.fn() },
    SEND_EMAIL: { send: vi.fn(async () => ({ messageId: 'msg_1' })) },
    EMAIL_SENDER_DOMAIN: MAIL_DOMAIN,
    ...overrides,
  };
}

async function postToProxy(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Response> {
  const worker = (await import('../../src/index.ts')).default;
  return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
    new Request('https://proxy.void.cloud/email/internal/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const sendMock = (env: Record<string, unknown>) =>
  (env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send;

describe('platform-internal send: api signature vs proxy verification', () => {
  it('the proxy accepts the api-signed request unmodified', async () => {
    // The contract test. Signer and verifier live in separately-bundled
    // workers; if either side changes the sentinel, the timestamp encoding,
    // or the `from|to|mimeBase64` hash, this is the only thing that notices.
    const send = await captureApiSend();
    const env = proxyEnv();

    const res = await postToProxy(env, send.body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMock(env)).toHaveBeenCalledTimes(1);
  });

  it('the proxy rejects the same token against a tampered recipient', async () => {
    // Replay within the 5-minute window against a different recipient. The
    // content binding is what makes this a 403 instead of a free send.
    const send = await captureApiSend();
    const env = proxyEnv();

    const res = await postToProxy(env, { ...send.body, to: 'attacker@example.com' });

    expect(res.status).toBe(403);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });

  it('the proxy rejects the same token against tampered mime bytes', async () => {
    const send = await captureApiSend();
    const env = proxyEnv();
    const evilMime = btoa('Subject: hi\r\n\r\nnot the confirmation mail\r\n');

    const res = await postToProxy(env, { ...send.body, mimeBase64: evilMime });

    expect(res.status).toBe(403);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });

  it('the proxy rejects a stale timestamp', async () => {
    const send = await captureApiSend();
    const env = proxyEnv();

    // Six minutes old — outside the proxy's 5-minute skew window. Moving the
    // timestamp also breaks the signature, which is the point: the timestamp
    // is inside the signed string.
    const res = await postToProxy(env, {
      ...send.body,
      platformTimestamp: send.body.platformTimestamp - 6 * 60,
    });

    expect(res.status).toBe(403);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });

  it('the proxy rejects an api signed with a different secret', async () => {
    const send = await captureApiSend({ JWT_SECRET: 'a-different-secret' });
    const env = proxyEnv();

    const res = await postToProxy(env, send.body);

    expect(res.status).toBe(403);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });

  it('the proxy rejects a correctly-signed send for a domain it is not configured for', async () => {
    // Both sides read their own `EMAIL_SENDER_DOMAIN`; the deploy contract is
    // that they name the same zone. A mismatch must fail closed rather than
    // let one environment sign mail for the other's zone.
    const send = await captureApiSend({ EMAIL_SENDER_DOMAIN: 'mail.void.cloud' });
    const env = proxyEnv({ EMAIL_SENDER_DOMAIN: MAIL_DOMAIN });

    const res = await postToProxy(env, send.body);

    expect(res.status).toBe(403);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });

  it('the proxy fails closed when it has no sender domain of its own', async () => {
    const send = await captureApiSend();
    const env = proxyEnv({ EMAIL_SENDER_DOMAIN: '' });

    const res = await postToProxy(env, send.body);

    expect(res.status).toBe(502);
    expect(sendMock(env)).not.toHaveBeenCalled();
  });
});
