import { defineHandler } from 'void';
import { ai } from 'void/ai';
import { env } from 'void/env';

// Root can change this literal between two disposable deployments for rollback proof.
export const acceptanceVersion = 'void-runtime-acceptance-v1';

export const GET = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({ ok: true, version: acceptanceVersion });
});

export const POST = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ action?: unknown; marker?: unknown }>().catch(() => null);
  if (body?.action === 'log') {
    if (typeof body.marker !== 'string' || !/^void-e2e-[a-f0-9]{16}$/.test(body.marker)) {
      return c.json({ error: 'invalid isolated log marker' }, 400);
    }
    console.log(body.marker);
    console.error(body.marker);
    // This fixed 503 also exercises dispatch request metering without logging user input.
    return c.json({ ok: true, marker: body.marker }, 503);
  }
  if (body?.action === 'ai' || body?.action === 'ai-stream') {
    const inputs = {
      messages: [{ role: 'user' as const, content: 'Say hello in one word.' }],
      max_tokens: 8,
    };
    const model = '@cf/meta/llama-3.2-1b-instruct';
    if (body.action === 'ai-stream') {
      return ai.stream(model, inputs);
    }
    const result = await ai.run(model, inputs);
    return c.json({ ok: true, result });
  }
  return c.json({ error: 'invalid acceptance action' }, 400);
});
