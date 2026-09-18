import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import {
  admitEmailAction,
  claimRelayedEmailReceipt,
  completeRelayedEmailReceipt,
  EmailAdmissionError,
  getEmailAction,
  recordEmailReceipt,
  transitionEmailRecipients,
} from '../email/admission.ts';
import type { EmailAdmissionInput } from '../email/admission.ts';
import type { ApiEnv } from '../env.ts';

const app = new Hono<ApiEnv>();

app.use('*', async (context, next) => {
  const signature = context.req.header('x-void-internal');
  if (!signature) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  if (Number(context.req.header('content-length')) > 32_768) {
    return context.json({ error: 'action request too large' }, 413);
  }
  const reader = context.req.raw.body?.getReader();
  if (!reader) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) {
        return context.json({ error: 'action request timed out' }, 408);
      }
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 32_768) {
        await reader.cancel();
        return context.json({ error: 'action request too large' }, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) {
      return context.json({ error: 'action request timed out' }, 408);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }
  if (!(await hmacVerifyState(raw, signature, context.env.JWT_SECRET))) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }
  context.set('emailActionBody' as never, body as never);
  await next();
});

function status(error: EmailAdmissionError): 400 | 404 | 409 {
  return error.code === 'NOT_FOUND'
    ? 404
    : error.code === 'CONFLICT' || error.code === 'INVALID_STATE'
      ? 409
      : 400;
}

app.post('/admit', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as EmailAdmissionInput;
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.projectId !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.digest !== 'string' ||
    typeof body.from !== 'string' ||
    !Array.isArray(body.recipients) ||
    !body.recipients.every((r) => typeof r === 'string') ||
    !['direct', 'forward', 'reply'].includes(body.kind) ||
    !['binding', 'send_raw', 'native_forward', 'native_reply'].includes(body.transport)
  ) {
    return context.json({ error: 'invalid admission request' }, 400);
  }
  try {
    return context.json(
      await admitEmailAction(context.get('db'), {
        ...body,
        sharedSenderDomain: context.env.EMAIL_SENDER_DOMAIN ?? '',
      }),
    );
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/receipts', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as {
    receiptId?: unknown;
    projectId?: unknown;
    status?: unknown;
  };
  if (
    typeof body?.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.status !== 'string'
  ) {
    return context.json({ error: 'invalid receipt' }, 400);
  }
  try {
    await recordEmailReceipt(context.get('db'), {
      receiptId: body.receiptId,
      projectId: body.projectId,
      status: body.status,
    });
    return context.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/receipts/claim', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as Record<string, unknown>;
  if (
    typeof body?.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.payloadDigest !== 'string'
  ) {
    return context.json({ error: 'invalid relay claim' }, 400);
  }
  try {
    return context.json(
      await claimRelayedEmailReceipt(context.get('db'), {
        receiptId: body.receiptId,
        projectId: body.projectId,
        payloadDigest: body.payloadDigest,
      }),
    );
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/receipts/complete', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as Record<string, unknown>;
  if (
    typeof body?.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.payloadDigest !== 'string' ||
    typeof body.reject !== 'boolean'
  ) {
    return context.json({ error: 'invalid relay completion' }, 400);
  }
  try {
    await completeRelayedEmailReceipt(context.get('db'), {
      receiptId: body.receiptId,
      projectId: body.projectId,
      payloadDigest: body.payloadDigest,
      reject: body.reject,
    });
    return context.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/:id/start', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as { recipients?: unknown };
  if (!Array.isArray(body?.recipients) || !body.recipients.every((r) => typeof r === 'string')) {
    return context.json({ error: 'invalid recipients' }, 400);
  }
  try {
    return context.json({
      recipients: await transitionEmailRecipients(
        context.get('db'),
        context.req.param('id'),
        body.recipients,
        'attempt_started',
      ),
    });
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/:id/finish', async (context) => {
  const body = context.get('emailActionBody' as never) as unknown as {
    recipients?: unknown;
    state?: unknown;
    providerReference?: unknown;
    errorCode?: unknown;
  };
  if (
    !Array.isArray(body?.recipients) ||
    !body.recipients.every((r) => typeof r === 'string') ||
    !['provider_accepted', 'failed', 'outcome_unknown', 'cancelled'].includes(String(body.state)) ||
    (body.providerReference !== undefined && typeof body.providerReference !== 'string') ||
    (body.errorCode !== undefined && typeof body.errorCode !== 'string')
  ) {
    return context.json({ error: 'invalid outcome' }, 400);
  }
  try {
    return context.json({
      recipients: await transitionEmailRecipients(
        context.get('db'),
        context.req.param('id'),
        body.recipients,
        body.state as 'provider_accepted' | 'failed' | 'outcome_unknown' | 'cancelled',
        {
          providerReference: body.providerReference as string | undefined,
          errorCode: body.errorCode as string | undefined,
        },
      ),
    });
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      return context.json({ error: error.message, code: error.code }, status(error));
    }
    throw error;
  }
});

app.post('/:id/status', async (context) => {
  const action = await getEmailAction(context.get('db'), context.req.param('id'));
  return action ? context.json(action) : context.json({ error: 'email action not found' }, 404);
});

export default app;
