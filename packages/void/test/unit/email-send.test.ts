import { afterEach, describe, expect, it } from 'vite-plus/test';
import { sendEmail } from '../../src/runtime/email.ts';
import { clearDevBuffer, listDevMessages } from '../../src/runtime/email/dev-inbox.ts';
import { createEmailTestHarness } from '../../src/runtime/email/testing.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

afterEach(() => {
  clearDevBuffer();
});

/**
 * Build a fake `__VOID_PROXY` service binding that responds to
 * `/email/send` with a canned response. Captures every request body for
 * assertion.
 */
function fakeProxy(handler: (body: unknown) => { status: number; body: unknown }): {
  proxy: { fetch(req: Request | string, init?: RequestInit): Promise<Response> };
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    proxy: {
      async fetch(req, init) {
        const url = typeof req === 'string' ? req : req.url;
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof ArrayBuffer
              ? new TextDecoder().decode(init.body)
              : '';
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          /* ignore */
        }
        calls.push({ url, body: parsed });
        const result = handler(parsed);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

const PROXY_ENV_KEYS = {
  __VOID_PROXY_TOKEN: 'tok',
  __PROJECT_ID: 'p_test',
};

describe('sendEmail (test harness)', () => {
  it('captures sends and returns ok with a dev id', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'Acme <hello@acme.dev>',
        to: 'user@example.com',
        subject: 'Welcome',
        text: 'Hi there',
        html: '<p>Hi there</p>',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ids).toHaveLength(1);
        expect(result.ids[0].recipient).toBe('user@example.com');
        expect(result.ids[0].messageId).toMatch(/^dev_/);
      }
      expect(harness.messages).toHaveLength(1);
      const m = harness.messages[0];
      expect(m.subject).toBe('Welcome');
      expect(m.from.email).toBe('hello@acme.dev');
      expect(m.to[0].email).toBe('user@example.com');
      expect(m.text).toBe('Hi there');
      expect(m.html).toBe('<p>Hi there</p>');
    } finally {
      harness.dispose();
    }
  });

  it('does not populate the dev buffer when only the harness sink is active', async () => {
    const harness = createEmailTestHarness();
    try {
      await sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 'harness-only',
        text: 'hi',
      });
      expect(listDevMessages().some((m) => m.subject === 'harness-only')).toBe(false);
      expect(harness.messages.some((m) => m.subject === 'harness-only')).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('clear() empties the harness without disposing the sink', async () => {
    const harness = createEmailTestHarness();
    try {
      await sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's1', text: 't' });
      harness.clear();
      expect(harness.messages).toHaveLength(0);
      await sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's2', text: 't' });
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0].subject).toBe('s2');
    } finally {
      harness.dispose();
    }
  });
});

describe('sendEmail (error mapping)', () => {
  it('returns INVALID_FROM for malformed sender', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'not-an-email',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns MIME_ERROR when neither text nor html is set', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
      } as Parameters<typeof sendEmail>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('MIME_ERROR');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns BINDING_MISSING when no sink and no __VOID_PROXY', async () => {
    const result = await withRuntimeEnv({}, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
    }
  });
});

describe('sendEmail (from defaulting)', () => {
  // The platform mail domain is injected per environment (`mail.void.cloud`
  // in production, its own zone in staging), so these tests deliberately use
  // a non-production value: a passing assertion then proves the address was
  // built from the binding rather than from a baked-in constant.
  const MAIL_DOMAIN = 'mail.staging.void.cloud';

  it('defaults from to <slug>+noreply@<__VOID_EMAIL_DOMAIN> when omitted and both bindings are injected', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0].from.email).toBe(`acme+noreply@${MAIL_DOMAIN}`);
    } finally {
      harness.dispose();
    }
  });

  it('defaults from to __VOID_EMAIL_FROM when omitted (own-account deploys)', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv(
        { __VOID_EMAIL_FROM: 'Acme <noreply@mail.acme.com>' },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from).toEqual({ email: 'noreply@mail.acme.com', name: 'Acme' });
    } finally {
      harness.dispose();
    }
  });

  it('prefers __VOID_EMAIL_FROM over the platform slug default', async () => {
    const harness = createEmailTestHarness();
    try {
      await withRuntimeEnv(
        {
          __VOID_EMAIL_FROM: 'noreply@mail.acme.com',
          __VOID_PROJECT_SLUG: 'acme',
          __VOID_EMAIL_DOMAIN: MAIL_DOMAIN,
        },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(harness.messages[0].from.email).toBe('noreply@mail.acme.com');
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM for a malformed __VOID_EMAIL_FROM instead of guessing', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_EMAIL_FROM: 'not-an-address' }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('respects explicit from even when both bindings are set', async () => {
    const harness = createEmailTestHarness();
    try {
      await withRuntimeEnv({ __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, () =>
        sendEmail({
          from: 'override@example.com',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
        }),
      );
      expect(harness.messages[0].from.email).toBe('override@example.com');
    } finally {
      harness.dispose();
    }
  });

  it('respects explicit from when neither binding is present', async () => {
    // The bindings only feed the default. A caller who supplies `from`
    // must keep working outside a deployed worker.
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({}, () =>
        sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from.email).toBe('a@x.dev');
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM when from is omitted and neither binding is available', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({}, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM (never a baked-in domain) when __VOID_EMAIL_DOMAIN is missing', async () => {
    // Regression guard for the whole point of the binding: with a slug but
    // no configured domain, the send must fail loudly rather than quietly
    // addressing the production zone.
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_PROJECT_SLUG: 'acme' }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
        expect(result.error.message).not.toContain('mail.void.cloud');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM when __VOID_PROJECT_SLUG is missing but the domain is set', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('refuses to substitute a malformed __VOID_PROJECT_SLUG', async () => {
    const harness = createEmailTestHarness();
    try {
      // Slug containing `@` would corrupt the resulting envelope address.
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: 'evil@x.com', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM (not MIME_ERROR) when from is explicitly null', async () => {
    // Regression: `null` previously slipped past the empty-from guard
    // and was passed to parseAddress, surfacing as MIME_ERROR.
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: null as unknown as string,
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('accepts a 56-char slug (RFC 5321 64-octet local-part limit minus +noreply)', async () => {
    const harness = createEmailTestHarness();
    try {
      const slug = 'a'.repeat(56);
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: slug, __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from.email).toBe(`${slug}+noreply@${MAIL_DOMAIN}`);
    } finally {
      harness.dispose();
    }
  });

  it('rejects a 57-char slug (would build a 65-octet local-part)', async () => {
    const harness = createEmailTestHarness();
    try {
      const slug = 'a'.repeat(57);
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: slug, __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });
});

describe('sendEmail (proxy round trip)', () => {
  it('returns ok and surfaces messageIds from the proxy', async () => {
    const { proxy, calls } = fakeProxy(() => ({
      status: 200,
      body: { ok: true, ids: [{ recipient: 'b@y.dev', messageId: 'cf-1' }] },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/email/send');
    const body = calls[0].body as Record<string, unknown>;
    expect(body.projectId).toBe('p_test');
    // Legacy auth field name (proxy still reads it under the historical
    // `aiToken` key). New `proxyToken` ships the same value so the proxy
    // can migrate without a coordinated release.
    expect(body.aiToken).toBe('tok');
    expect(body.proxyToken).toBe('tok');
    expect(body.from).toBe('a@x.dev');
    expect(Array.isArray(body.recipients)).toBe(true);
    expect(body.recipients as Array<string>).toEqual(['b@y.dev']);
    expect(typeof body.mimeBase64).toBe('string');
    expect((body.mimeBase64 as string).length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toEqual([{ recipient: 'b@y.dev', messageId: 'cf-1' }]);
    }
  });

  it('falls back to the locally-generated messageId when the proxy returns an empty one', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 200,
      body: { ok: true, ids: [{ recipient: 'b@y.dev', messageId: '' }] },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids[0].messageId).toMatch(/^<.+@x\.dev>$/);
    }
  });

  it('surfaces QUOTA_EXCEEDED when the proxy denies the send', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 429,
      body: { ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'monthly cap reached' } },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('QUOTA_EXCEEDED');
      expect(result.error.message).toContain('monthly cap reached');
    }
  });

  it('returns UPSTREAM_ERROR on proxy fetch failure', async () => {
    const proxy = {
      async fetch() {
        throw new Error('network unreachable');
      },
    };
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
    }
  });

  it('passes mid-batch deliveries through unchanged', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          {
            recipient: 'b@y.dev',
            ok: false,
            error: { code: 'UNVERIFIED_DESTINATION', message: 'b@y.dev not verified' },
          },
          { recipient: 'c@y.dev', ok: true, messageId: 'cf-c' },
        ],
      },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: ['a@y.dev', 'b@y.dev', 'c@y.dev'],
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'deliveries' in result) {
      expect(result.deliveries).toHaveLength(3);
      const b = result.deliveries.find((d) => d.recipient === 'b@y.dev');
      expect(b?.ok).toBe(false);
      if (b && !b.ok) {
        expect(b.error.code).toBe('UNVERIFIED_DESTINATION');
      }
    }
  });

  it('coerces unknown error codes to UPSTREAM_ERROR', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 500,
      body: { ok: false, error: { code: 'WEIRD_NEW_CODE', message: 'something broke' } },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('something broke');
    }
  });

  it.each([
    ['null body', null],
    ['empty object', {}],
    ['ok:true with no ids', { ok: true }],
    ['ok:true with non-array ids', { ok: true, ids: 'string' }],
    ['ok:false with neither error nor deliveries', { ok: false }],
    ['primitive number body', 42],
    ['primitive array body', []],
  ])('returns UPSTREAM_ERROR (no throw) for malformed proxy response: %s', async (_, payload) => {
    const { proxy } = fakeProxy(() => ({ status: 200, body: payload }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
    }
  });

  it('drops malformed delivery entries inside an otherwise-valid mid-batch response', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          null, // garbage entry: must not crash the map
          { recipient: 'b@y.dev', ok: false, error: null }, // missing error.message
          'string-not-object',
          { ok: true, messageId: 'cf-x' }, // missing recipient
        ],
      },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: ['a@y.dev', 'b@y.dev'],
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'deliveries' in result) {
      // Two valid entries (a@y.dev ok, b@y.dev failed) survive; garbage is dropped.
      expect(result.deliveries).toHaveLength(2);
      const a = result.deliveries.find((d) => d.recipient === 'a@y.dev');
      expect(a?.ok).toBe(true);
      const b = result.deliveries.find((d) => d.recipient === 'b@y.dev');
      expect(b?.ok).toBe(false);
      if (b && !b.ok) {
        expect(b.error.code).toBe('UPSTREAM_ERROR');
      }
    }
  });

  it('returns UPSTREAM_ERROR when proxy responds with non-JSON', async () => {
    const proxy = {
      async fetch() {
        return new Response('not json', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        });
      },
    };
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
    }
  });

  it('dedupes recipients across to/cc/bcc and sends one envelope per unique address', async () => {
    const { calls, proxy } = fakeProxy((body) => {
      const recipients = (body as { recipients: Array<string> }).recipients;
      return {
        status: 200,
        body: {
          ok: true,
          ids: recipients.map((r) => ({ recipient: r, messageId: `cf-${r}` })),
        },
      };
    });
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        cc: 'B@Y.DEV',
        bcc: ['b@y.dev', 'c@y.dev'],
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    const recipients = (calls[0].body as { recipients: Array<string> }).recipients;
    expect(recipients).toEqual(['b@y.dev', 'c@y.dev']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toHaveLength(2);
    }
  });
});

describe('sendEmail (sendInDev escape hatch)', () => {
  it('bypasses the harness and calls the proxy', async () => {
    const harness = createEmailTestHarness();
    try {
      const { proxy, calls } = fakeProxy(() => ({
        status: 200,
        body: { ok: true, ids: [{ recipient: 'b@y.dev', messageId: 'cf-id-123' }] },
      }));
      const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
        sendEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
          sendInDev: true,
        }),
      );
      expect(harness.messages).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ids[0].messageId).toBe('cf-id-123');
      }
    } finally {
      harness.dispose();
    }
  });
});
