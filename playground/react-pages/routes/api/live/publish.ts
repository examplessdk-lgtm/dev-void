import { defineHandler } from 'void';
import { LIVE_PLAYGROUND_TOPIC, live } from '../../../src/live.ts';

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ message?: unknown }>().catch(() => null);
  const text =
    typeof body?.message === 'string' && body.message.trim()
      ? body.message.trim()
      : 'Hello from the React Pages playground';
  const eventId = crypto.randomUUID();

  await live.publish(
    LIVE_PLAYGROUND_TOPIC,
    {
      text,
      sentAt: new Date().toISOString(),
    },
    {
      type: 'message',
      eventId,
    },
  );

  return c.json({ ok: true, eventId });
});
