import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  RELAY_COMPATIBILITY_DATE,
  RELAY_EMAIL_DOMAIN_BINDING,
  RELAY_PROXY_ORIGIN_BINDING,
  RELAY_SECRET_BINDING,
  RELAY_SOURCE,
  RELAY_VERSION,
} from '../../src/email/relay-worker.ts';

// Dummy stand-ins — never real secret material.
const RELAY_SECRET = 'relay-secret-dummy';

type RelayEnv = Record<string, string>;
type RelayMessage = {
  from: string;
  to: string;
  raw: string;
  rawSize: number;
  setReject: (reason: string) => void;
};

/**
 * Evaluate the embedded module-syntax source as-is and return its default
 * export, so the wire test exercises the exact code the api deploys.
 */
function loadRelayWorker(): {
  email: (
    message: RelayMessage,
    env: RelayEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ) => Promise<void>;
} {
  const factory = new Function(RELAY_SOURCE.replace('export default', 'return')) as () => {
    email: (
      message: RelayMessage,
      env: RelayEnv,
      ctx: { waitUntil: (p: Promise<unknown>) => void },
    ) => Promise<void>;
  };
  return factory();
}

function relayContext() {
  const env: RelayEnv = {
    [RELAY_SECRET_BINDING]: RELAY_SECRET,
    [RELAY_PROXY_ORIGIN_BINDING]: 'https://proxy.example.test',
    [RELAY_EMAIL_DOMAIN_BINDING]: 'acme.com',
  };
  const raw = 'MIME-DUMMY-BODY';
  const message: RelayMessage = {
    from: 'sender@example.org',
    to: 'support@acme.com',
    raw,
    rawSize: raw.length,
    setReject: vi.fn(),
  };
  const ctx = { waitUntil: vi.fn() };
  return { env, message, ctx };
}

describe('RELAY_SOURCE', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ships an integer RELAY_VERSION and a module-syntax default export', () => {
    expect(Number.isInteger(RELAY_VERSION)).toBe(true);
    expect(RELAY_SOURCE).toContain('export default');
    expect(RELAY_SOURCE).toContain('async email(message, env, ctx)');
    // No parsing, no buffering, no third-party imports.
    expect(RELAY_SOURCE).not.toContain('import');
  });

  it('reads exactly the binding names the uploader declares', () => {
    for (const binding of [
      RELAY_SECRET_BINDING,
      RELAY_PROXY_ORIGIN_BINDING,
      RELAY_EMAIL_DOMAIN_BINDING,
    ]) {
      expect(RELAY_SOURCE).toContain(`env.${binding}`);
    }
    expect(RELAY_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('POSTs the raw MIME to /email/relay with the contract-3 headers', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();

    await loadRelayWorker().email(message, env, ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example.test/email/relay');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${RELAY_SECRET}`,
      'X-Void-Email-Domain': 'acme.com',
      'X-Void-Email-From': 'sender@example.org',
      'X-Void-Email-To': 'support@acme.com',
      'Content-Length': String(message.rawSize),
    });
    // Streamed straight through — no base64, no JSON envelope.
    expect(init.body).toBe(message.raw);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('refuses mail addressed to a different domain on the zone, without POSTing', async () => {
    // The catch-all can be zone-wide: mail addressed to a DIFFERENT domain
    // on the same zone can land here. It is not this relay's to forward —
    // refuse it loudly (a bounce for the sender), never forward it under
    // this domain's secret. RELAY_VERSION 2.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();
    message.to = 'user@other-acme.com';

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).toHaveBeenCalledOnce();
    const reason = (message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(reason).not.toContain(RELAY_SECRET);
    expect(reason).not.toContain('other-acme.com');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('matches the recipient domain against VOID_EMAIL_DOMAIN case-insensitively', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();
    message.to = 'Support@ACME.COM';

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects with a short generic reason on a non-2xx answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).toHaveBeenCalledOnce();
    const reason = (message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeLessThanOrEqual(64);
    // The bounce goes back to the original sender — no internals leak.
    expect(reason).not.toContain(RELAY_SECRET);
    expect(reason).not.toContain('proxy.example.test');
    expect(reason).not.toContain('502');
  });
});
