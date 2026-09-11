/**
 * Email on the developer's OWN Cloudflare account (`void deploy --platform
 * cloudflare`, design-doc 0078 "Mode B").
 *
 * Two things differ from the managed platform and both are exercised here
 * with `cloudflare:email` faked, since the real module exists only in workerd:
 *
 *   outbound  sendEmail() -> env.SEND_EMAIL.send(new EmailMessage(...)),
 *             one envelope per recipient, no proxy hop
 *   inbound   Cloudflare calls the worker's `email()` with a REAL
 *             `ForwardableEmailMessage` and ignores the return value, so the
 *             generated entry must ENACT the recorded actions on it
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  createMessageProxy,
  enactEmailActions,
  isForwardableEmailMessage,
  parseEmail,
  replyEmail,
} from '../../src/runtime/email/inbound.ts';
import { createEmailTestHarness } from '../../src/runtime/email/testing.ts';
import { envContext } from '../../src/runtime/env-raw.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

// Stand-in for workerd's `EmailMessage`. It only needs to be a recognisable
// class that keeps its constructor arguments, so a test can assert which
// envelope reached the binding and that a genuine instance (not a duck-typed
// object) was handed to `reply()`.
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

async function readAll(raw: ReadableStream<Uint8Array> | string): Promise<string> {
  if (typeof raw === 'string') {
    return raw;
  }
  const reader = raw.getReader();
  let out = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** An error shaped the way Email Service throws them: `Error` + `code`. */
function bindingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function fakeSendBinding(
  respond: (msg: InstanceType<typeof fake.FakeEmailMessage>) => { messageId?: string } | undefined,
): {
  binding: { send(msg: unknown): Promise<{ messageId?: string } | undefined> };
  sent: Array<InstanceType<typeof fake.FakeEmailMessage>>;
} {
  const sent: Array<InstanceType<typeof fake.FakeEmailMessage>> = [];
  return {
    sent,
    binding: {
      async send(msg: unknown) {
        expect(msg).toBeInstanceOf(fake.FakeEmailMessage);
        const m = msg as InstanceType<typeof fake.FakeEmailMessage>;
        sent.push(m);
        return respond(m);
      },
    },
  };
}

describe('sendEmail (SEND_EMAIL binding)', () => {
  it('sends one EmailMessage per unique recipient and surfaces the binding messageIds', async () => {
    const { binding, sent } = fakeSendBinding((m) => ({ messageId: `cf-${m.to}` }));
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({
        from: 'Acme <support@mail.acme.com>',
        to: ['alice@example.com', 'Bob <bob@example.com>'],
        cc: 'ALICE@example.com',
        subject: 'Welcome',
        text: 'Hi there',
      }),
    );

    expect(result).toEqual({
      ok: true,
      ids: [
        { recipient: 'alice@example.com', messageId: 'cf-alice@example.com' },
        { recipient: 'bob@example.com', messageId: 'cf-bob@example.com' },
      ],
    });
    expect(sent.map((m) => [m.from, m.to])).toEqual([
      ['support@mail.acme.com', 'alice@example.com'],
      ['support@mail.acme.com', 'bob@example.com'],
    ]);
    // Each envelope carries the shared MIME, on a fresh stream.
    const bodies = await Promise.all(sent.map((m) => readAll(m.raw)));
    for (const body of bodies) {
      expect(body).toContain('Subject: Welcome');
      expect(body).toContain('Hi there');
    }
  });

  it('falls back to the locally generated messageId when the binding returns none', async () => {
    const { binding } = fakeSendBinding(() => undefined);
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids[0].messageId).toMatch(/@/);
    }
  });

  it('is tried before __VOID_PROXY', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const proxyCalls: Array<string> = [];
    const proxy = {
      async fetch(req: Request | string) {
        proxyCalls.push(typeof req === 'string' ? req : req.url);
        return new Response('{"ok":true,"ids":[]}');
      },
    };
    const result = await withRuntimeEnv(
      { SEND_EMAIL: binding, __VOID_PROXY: proxy, __VOID_PROXY_TOKEN: 't', __PROJECT_ID: 'p' },
      () => sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(proxyCalls).toEqual([]);
  });

  it('yields to the dev inbox / test harness sink', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
        sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages).toHaveLength(1);
      expect(sent).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('defaults from to __VOID_EMAIL_FROM', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const result = await withRuntimeEnv(
      { SEND_EMAIL: binding, __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      () => sendEmail({ to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    expect(sent[0].from).toBe('noreply@mail.acme.com');
    expect(await readAll(sent[0].raw)).toContain('From: noreply@mail.acme.com');
  });

  it.each([
    ['E_RECIPIENT_NOT_ALLOWED', 'UNVERIFIED_DESTINATION'],
    ['E_SENDER_NOT_VERIFIED', 'INVALID_FROM'],
    ['E_SENDER_DOMAIN_NOT_AVAILABLE', 'INVALID_FROM'],
    ['E_RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['E_DAILY_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['E_DELIVERY_FAILED', 'UPSTREAM_ERROR'],
    ['E_INTERNAL_SERVER_ERROR', 'UPSTREAM_ERROR'],
  ])(
    'maps a thrown %s to %s per recipient, keeping the Cloudflare message',
    async (cfCode, code) => {
      const thrown = bindingError(cfCode, `cloudflare says: ${cfCode}`);
      const { binding } = fakeSendBinding(() => {
        throw thrown;
      });
      const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
        sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
      );
      expect(result).toEqual({
        ok: false,
        deliveries: [
          {
            recipient: 'b@example.com',
            ok: false,
            error: { code, message: `cloudflare says: ${cfCode}`, cause: thrown },
          },
        ],
      });
    },
  );

  it('recognises the older message-only "destination address not verified" error', async () => {
    const { binding } = fakeSendBinding(() => {
      throw new Error('destination address b@example.com not verified');
    });
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'deliveries' in result) {
      expect(result.deliveries[0]).toMatchObject({
        ok: false,
        error: { code: 'UNVERIFIED_DESTINATION' },
      });
    } else {
      throw new Error('expected a per-recipient failure');
    }
  });

  it('attempts every recipient and reports a mid-batch failure in the proxy shape', async () => {
    const { binding, sent } = fakeSendBinding((m) => {
      if (m.to === 'blocked@example.com') {
        throw bindingError('E_RECIPIENT_NOT_ALLOWED', 'not allowed');
      }
      return { messageId: `cf-${m.to}` };
    });
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({
        from: 'a@mail.acme.com',
        to: ['blocked@example.com', 'ok@example.com'],
        subject: 's',
        text: 't',
      }),
    );
    expect(sent.map((m) => m.to)).toEqual(['blocked@example.com', 'ok@example.com']);
    expect(result).toMatchObject({
      ok: false,
      deliveries: [
        {
          recipient: 'blocked@example.com',
          ok: false,
          error: { code: 'UNVERIFIED_DESTINATION', message: 'not allowed' },
        },
        { recipient: 'ok@example.com', ok: true, messageId: 'cf-ok@example.com' },
      ],
    });
  });
});

/**
 * A `ForwardableEmailMessage` as workerd hands it to `email()`: a one-shot
 * raw stream, a `Headers` instance, and the three native methods, each
 * recording its call.
 */
function nativeMessage(opts: { from: string; to: string; mime: string }): {
  message: ForwardableEmailMessage;
  calls: {
    rejects: Array<string>;
    forwards: Array<{ to: string; headers: Headers | undefined }>;
    replies: Array<unknown>;
  };
} {
  const bytes = new TextEncoder().encode(opts.mime);
  const headers = new Headers();
  for (const line of opts.mime.split('\r\n\r\n')[0].split('\r\n')) {
    const idx = line.indexOf(':');
    headers.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  const calls = {
    rejects: [] as Array<string>,
    forwards: [] as Array<{ to: string; headers: Headers | undefined }>,
    replies: [] as Array<unknown>,
  };
  const message = {
    from: opts.from,
    to: opts.to,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      calls.rejects.push(reason);
    },
    async forward(to: string, fwdHeaders?: Headers) {
      calls.forwards.push({ to, headers: fwdHeaders });
      return { messageId: 'fwd' };
    },
    async reply(reply: unknown) {
      calls.replies.push(reply);
      return { messageId: 'rep' };
    },
  } as unknown as ForwardableEmailMessage;
  return { message, calls };
}

const INBOUND_MIME =
  'From: sender@example.com\r\n' +
  'To: support@mail.acme.com\r\n' +
  'Subject: Help\r\n' +
  'Message-ID: <orig-1@example.com>\r\n' +
  '\r\n' +
  'my order is missing\r\n';

/**
 * Runs the GENERATED `handleEmail` from `compileWorkerEntry` with the real
 * runtime wired in and the user handler injected — the seam between "record
 * the actions" and "enact them on the native message" is what is under test.
 */
function buildHandleEmail(
  userHandler: (message: ForwardableEmailMessage, env: unknown, ctx: unknown) => Promise<void>,
): (envelope: unknown, env: unknown, ctx: unknown) => Promise<unknown> {
  const code = compileWorkerEntry({ hasEmail: true });
  const start = code.indexOf('async function handleEmail');
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf('\n}\n', start);
  const body = code.slice(start, end + 3);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(
    '__filterInternalBindings',
    '__createMessageProxy',
    '__enactEmailActions',
    '__isForwardableEmailMessage',
    '__withRawEnv',
    'withRuntimeEnv',
    '__emailHandler',
    `${body}\nreturn handleEmail;`,
  )(
    (env: unknown) => env,
    createMessageProxy,
    enactEmailActions,
    isForwardableEmailMessage,
    (env: unknown, fn: () => unknown) => envContext.run(env as never, fn),
    withRuntimeEnv,
    userHandler,
  ) as never;
}

describe('generated handleEmail on a native ForwardableEmailMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enacts setReject on the real message', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      message.setReject('no thanks');
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    const actions = await handleEmail(message, {}, {});

    expect(calls.rejects).toEqual(['no thanks']);
    expect(actions).toEqual([{ type: 'reject', reason: 'no thanks' }]);
  });

  it('enacts forward with its headers as a Headers instance', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await message.forward('ops@acme.com', new Headers({ 'X-Void-Trace': 'abc' }));
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    await handleEmail(message, {}, {});

    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].to).toBe('ops@acme.com');
    expect(calls.forwards[0].headers).toBeInstanceOf(Headers);
    expect(calls.forwards[0].headers?.get('X-Void-Trace')).toBe('abc');
  });

  it('enacts replyEmail as a real EmailMessage sent from the delivered address', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      // Both reads of the one-shot native stream must work: the proxy
      // buffers it so a parse followed by a reply is the ordinary case.
      const parsed = await parseEmail(message);
      await replyEmail(message, { text: `re: ${parsed.text?.trim()}` });
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    // No __VOID_PROJECT_SLUG: the reply sender is message.to itself.
    const actions = await handleEmail(message, {}, {});

    expect(calls.replies).toHaveLength(1);
    const reply = calls.replies[0] as InstanceType<typeof fake.FakeEmailMessage>;
    expect(reply).toBeInstanceOf(fake.FakeEmailMessage);
    expect(reply.from).toBe('support@mail.acme.com');
    expect(reply.to).toBe('sender@example.com');
    const raw = await readAll(reply.raw);
    expect(raw).toContain('Subject: Re: Help');
    expect(raw).toContain('In-Reply-To: <orig-1@example.com>');
    expect(raw).toContain('re: my order is missing');
    expect(actions).toMatchObject([
      { type: 'reply', from: 'support@mail.acme.com', to: 'sender@example.com' },
    ]);
  });

  it('keeps the platform reply sender when a slug is injected', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await replyEmail(message, { text: 'ack' });
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      mime: INBOUND_MIME,
    });

    await handleEmail(
      message,
      { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: 'mail.void.cloud' },
      {},
    );

    const reply = calls.replies[0] as InstanceType<typeof fake.FakeEmailMessage>;
    expect(reply.from).toBe('acme+noreply@mail.void.cloud');
  });

  it('enacts a reject that followed a forward as the reject alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handleEmail = buildHandleEmail(async (message) => {
      await message.forward('ops@acme.com');
      message.setReject('changed my mind');
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    await handleEmail(message, {}, {});

    expect(calls.forwards).toEqual([]);
    expect(calls.rejects).toEqual(['changed my mind']);
  });

  it('still returns the actions as data for a platform envelope, enacting nothing', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      message.setReject('spam');
    });
    const envelope = {
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
    };

    const actions = await handleEmail(envelope, { __VOID_PROJECT_SLUG: 'acme' }, {});

    expect(actions).toEqual([{ type: 'reject', reason: 'spam' }]);
    expect(isForwardableEmailMessage(envelope)).toBe(false);
  });
});
