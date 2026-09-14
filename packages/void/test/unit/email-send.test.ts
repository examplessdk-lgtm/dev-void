import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  clearDevBuffer,
  DEV_INBOX_ENV_VAR,
  listDevMessages,
} from '../../src/runtime/email/dev-inbox.ts';
import { createEmailTestHarness } from '../../src/runtime/email/testing.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

afterEach(() => {
  clearDevBuffer();
});

// Stand-in for workerd's `EmailMessage`, so the own-account `SEND_EMAIL`
// transport can run in the plain-node runner and its result be compared
// with a captured one.
const fake = vi.hoisted(() => {
  class FakeEmailMessage {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: ReadableStream<Uint8Array> | string,
    ) {}
  }
  return { FakeEmailMessage };
});

vi.mock('cloudflare:email', () => ({ EmailMessage: fake.FakeEmailMessage }));

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

  // A captured result must be the result a deploy returns. Both production
  // transports send to `uniqueRecipients()` — one envelope per address,
  // matched case-insensitively and reported lowercased — while the capture
  // path mapped every `to`/`cc`/`bcc` occurrence in its original case, so a
  // test written against it expected four deliveries where production makes
  // two. The captured MESSAGE still carries the fields as given: the inbox
  // shows what was asked for, `ids` reports what would be sent.
  it('reports one id per unique address, the way the production transports do', async () => {
    const opts = {
      from: 'a@x.dev',
      to: ['A@x.dev'],
      cc: ['a@x.dev'],
      bcc: ['Bob <B@x.dev>', 'b@x.dev'],
      subject: 's',
      text: 't',
    };
    const harness = createEmailTestHarness();
    let captured: Awaited<ReturnType<typeof sendEmail>>;
    try {
      captured = await sendEmail(opts);
      expect(harness.messages).toHaveLength(1);
      const m = harness.messages[0];
      expect(m.to).toEqual([{ email: 'A@x.dev' }]);
      expect(m.cc).toEqual([{ email: 'a@x.dev' }]);
      expect(m.bcc).toEqual([{ email: 'B@x.dev', name: 'Bob' }, { email: 'b@x.dev' }]);
    } finally {
      harness.dispose();
    }
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    expect(captured.ids).toEqual([
      { recipient: 'a@x.dev', messageId: captured.ids[0].messageId },
      { recipient: 'b@x.dev', messageId: captured.ids[0].messageId },
    ]);
    expect(captured.ids[0].messageId).toMatch(/^dev_/);

    // The same call through the own-account binding: the recipients the
    // capture reported are exactly the envelopes production sends.
    const sent: Array<string> = [];
    const binding = {
      async send(msg: unknown) {
        const m = msg as InstanceType<typeof fake.FakeEmailMessage>;
        sent.push(m.to);
        return { messageId: `cf-${m.to}` };
      },
    };
    const deployed = await withRuntimeEnv({ SEND_EMAIL: binding }, () => sendEmail(opts));
    expect(deployed.ok).toBe(true);
    if (deployed.ok) {
      expect(deployed.ids.map((d) => d.recipient)).toEqual(captured.ids.map((d) => d.recipient));
      expect(sent).toEqual(captured.ids.map((d) => d.recipient));
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

  it('returns INVALID_TO for an oversize recipient list before any transport is tried', async () => {
    // Pre-flight: it must come back as a top-level `error`, from the
    // harness (`void dev`) exactly as it would from a deployed worker — the
    // proxy's own 100-recipient refusal used to be the first place a list
    // like this was ever rejected, and only after the tenant had built it.
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'a@x.dev',
        to: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`),
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_TO');
        expect(result.error.message).toMatch(/too many recipients \(max 100, got 101\)/);
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
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

  it('rejects an explicit 65-octet local part before capture, like the slug default', async () => {
    // The slug default above refuses to BUILD a 65-octet local part, but the
    // same address passed explicitly used to be captured as a success —
    // under `void dev` and here — and could only bounce at an MTA.
    const harness = createEmailTestHarness();
    try {
      const from = await sendEmail({
        from: `${'a'.repeat(57)}+noreply@${MAIL_DOMAIN}`,
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(from.ok).toBe(false);
      if (!from.ok && 'error' in from) {
        expect(from.error.code).toBe('INVALID_FROM');
        expect(from.error.message).toMatch(/local part is 65 octets, over the 64-octet limit/);
      }
      const to = await sendEmail({
        from: 'a@x.dev',
        to: `${'a'.repeat(65)}@y.dev`,
        subject: 's',
        text: 't',
      });
      expect(to.ok).toBe(false);
      if (!to.ok && 'error' in to) {
        expect(to.error.code).toBe('INVALID_TO');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('rejects a 257-octet address before capture, whatever its local part', async () => {
    // `a@` + a 255-octet domain is under the 320 total and the 64-octet
    // local part, and used to be captured as a success — under `void dev`
    // and here — when RFC 5321 §4.5.3.1.3 caps the path at 256 octets.
    const label = 'b'.repeat(63);
    const over = `a@${[label, label, label, label].join('.')}`;
    expect(over).toHaveLength(257);
    const harness = createEmailTestHarness();
    try {
      const from = await sendEmail({ from: over, to: 'b@y.dev', subject: 's', text: 't' });
      expect(from.ok).toBe(false);
      if (!from.ok && 'error' in from) {
        expect(from.error.code).toBe('INVALID_FROM');
        expect(from.error.message).toMatch(/address is 257 octets, over the 254-octet limit/);
      }
      const to = await sendEmail({ from: 'a@x.dev', to: over, subject: 's', text: 't' });
      expect(to.ok).toBe(false);
      if (!to.ok && 'error' in to) {
        expect(to.error.code).toBe('INVALID_TO');
      }
      expect(harness.messages).toHaveLength(0);
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

  // The test above hand-injects `__VOID_PROXY`, which `void dev` never
  // produces: the platform adds that service binding only on a deployed
  // worker, and the own-account `SEND_EMAIL` binding is deleted from the
  // resolved worker config whenever `viteCommand === 'serve'`. So under a
  // real dev server `sendInDev: true` bypasses the inbox and lands on
  // nothing. Pin that, message text included, so re-adding a send binding
  // to dev has to come past this test.
  it('returns BINDING_MISSING under a real `void dev` env (no transport to fall through to)', async () => {
    const assets = {
      calls: 0,
      async fetch() {
        this.calls += 1;
        return new Response('unreachable', { status: 500 });
      },
    };
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    // The inbox was bypassed: nothing was posted to the dev server, and
    // nothing was buffered.
    expect(assets.calls).toBe(0);
    expect(listDevMessages()).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
      expect(result.error.message).toContain('`sendInDev: true`, which does not deliver');
      expect(result.error.message).toContain('`void dev` binds no send transport at all');
    }
  });
});
