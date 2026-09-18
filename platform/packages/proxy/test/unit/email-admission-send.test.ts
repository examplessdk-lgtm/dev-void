import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: unknown,
    ) {}
  },
}));
const { email } = await import('../../src/email.ts');

function fixture() {
  const actions = new Map<
    string,
    {
      operationId: string;
      digest: string;
      recipients: Array<{
        recipient: string;
        state: string;
        errorCode: string | null;
        providerReference: string | null;
      }>;
    }
  >();
  const apiFetch = vi.fn(async (request: Request | string, init?: RequestInit) => {
    const path = new URL(typeof request === 'string' ? request : request.url).pathname;
    const body = (
      typeof request === 'string' ? JSON.parse(String(init?.body)) : await request.json()
    ) as Record<string, unknown>;
    if (path.endsWith('/admit')) {
      const key = body.key as string;
      const previous = actions.get(key);
      if (previous && previous.digest !== body.digest) {
        return Response.json({ code: 'CONFLICT' }, { status: 409 });
      }
      if (previous) {
        return Response.json({
          operationId: previous.operationId,
          replay: true,
          recipients: previous.recipients,
        });
      }
      const entry = {
        operationId: `act_${key}`,
        digest: body.digest as string,
        recipients: (body.recipients as Array<string>).map((recipient) => ({
          recipient,
          state: 'reserved',
          errorCode: null,
          providerReference: null,
        })),
      };
      actions.set(key, entry);
      return Response.json({
        operationId: entry.operationId,
        replay: false,
        recipients: entry.recipients,
      });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((a) => a.operationId === operationId)!;
    if (path.endsWith('/start')) {
      for (const recipient of body.recipients as Array<string>) {
        entry.recipients.find((r) => r.recipient === recipient)!.state = 'attempt_started';
      }
    } else if (path.endsWith('/finish')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((r) => r.recipient === recipient)!;
        row.state = body.state as string;
        row.providerReference = (body.providerReference as string) ?? null;
        row.errorCode = (body.errorCode as string) ?? null;
      }
    }
    return Response.json({ recipients: entry.recipients });
  });
  const sender = vi.fn(async () => ({ messageId: 'provider-1' }));
  const env = {
    API: { fetch: apiFetch },
    JWT_SECRET: 'test-secret',
    SEND_EMAIL: { send: sender },
    EMAIL_SENDER_DOMAIN: 'mail.example.com',
    ROUTING: { get: vi.fn() },
  };
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('projectId', 'proj_1');
    context.set('body', await context.req.json());
    await next();
  });
  app.route('/email', email);
  const send = async (key: string, recipients = ['one@example.com']) =>
    app.request(
      '/email/send',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: 'acme+news@mail.example.com',
          recipients,
          mimeBase64: btoa('From: acme+news@mail.example.com\r\nSubject: hello\r\n\r\nbody'),
          idempotencyKey: key,
        }),
      },
      env,
    );
  return { send, sender, apiFetch, actions };
}

describe('proxy email admission delivery', () => {
  it('replays a caller key without another provider submission', async () => {
    const test = fixture();
    expect((await test.send('one')).status).toBe(200);
    expect((await test.send('one')).status).toBe(200);
    expect(test.sender).toHaveBeenCalledTimes(1);
    expect(test.actions.get('one')?.recipients[0]?.state).toBe('provider_accepted');
  });

  it('persists uncertainty for one recipient while continuing a partial fanout', async () => {
    const test = fixture();
    test.sender.mockImplementationOnce(async () => {
      throw new Error('timeout');
    });
    const result = await test.send('partial', ['one@example.com', 'two@example.com']);
    const body = (await result.json()) as {
      deliveries: Array<{ recipient: string; state: string }>;
    };
    expect(body.deliveries).toEqual(
      expect.arrayContaining([
        {
          recipient: 'one@example.com',
          state: 'outcome_unknown',
          ok: false,
          error: expect.any(Object),
        },
        {
          recipient: 'two@example.com',
          state: 'provider_accepted',
          ok: true,
          messageId: 'provider-1',
        },
      ]),
    );
    expect(test.actions.get('partial')?.recipients.map((r) => r.state)).toEqual([
      'outcome_unknown',
      'provider_accepted',
    ]);
  });
});
