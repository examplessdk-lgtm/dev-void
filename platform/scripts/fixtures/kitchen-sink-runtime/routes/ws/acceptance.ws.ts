import * as v from 'valibot';
import { defineWebSocket } from 'void/ws';

const marker = v.pipe(v.string(), v.regex(/^void-e2e-[a-f0-9]{16}$/));

export default defineWebSocket({
  messages: {
    client: v.object({ marker }),
    server: v.object({ kind: v.literal('echo'), marker }),
  },
  onBeforeConnect(ctx) {
    const secret = ctx.env.SECRET_KEY;
    if (
      typeof secret !== 'string' ||
      !secret ||
      ctx.request.headers.get('x-void-e2e-token') !== secret
    ) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  },
  async onMessage(ctx, event) {
    await ctx.socket.send({ kind: 'echo', marker: event.marker });
  },
});
