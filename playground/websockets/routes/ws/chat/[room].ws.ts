import * as v from 'valibot';
import { defineRoom } from 'void/ws';

const ChatClientMessage = v.variant('type', [
  v.object({
    type: v.literal('chat.join'),
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(24)),
  }),
  v.object({
    type: v.literal('chat.message'),
    text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(280)),
  }),
]);

const ChatServerMessage = v.variant('type', [
  v.object({
    type: v.literal('chat.system'),
    id: v.string(),
    text: v.string(),
    activeConnections: v.number(),
  }),
  v.object({
    type: v.literal('chat.message'),
    id: v.string(),
    name: v.string(),
    text: v.string(),
    sentAt: v.string(),
  }),
]);

interface ChatConnectionState {
  name?: string;
}

function activeConnectionCount(
  room: Parameters<NonNullable<typeof definition.onConnect>>[0]['room'],
): number {
  return Array.from(room.getConnections()).length;
}

const definition = defineRoom({
  messages: {
    client: ChatClientMessage,
    server: ChatServerMessage,
  },
  async onConnect(ctx) {
    await ctx.connection.send({
      type: 'chat.system',
      id: crypto.randomUUID(),
      text: `Connected to room "${ctx.params.room}"`,
      activeConnections: activeConnectionCount(ctx.room),
    });
  },
  async onMessage(ctx, event) {
    if (event.type === 'chat.join') {
      ctx.connection.setState({ name: event.name } satisfies ChatConnectionState);
      await ctx.room.broadcast({
        type: 'chat.system',
        id: crypto.randomUUID(),
        text: `${event.name} joined ${ctx.params.room}`,
        activeConnections: activeConnectionCount(ctx.room),
      });
      return;
    }

    const state = (ctx.connection.state as ChatConnectionState | undefined) ?? {};
    if (!state.name) {
      await ctx.connection.send({
        type: 'chat.system',
        id: crypto.randomUUID(),
        text: 'Join the room before sending messages',
        activeConnections: activeConnectionCount(ctx.room),
      });
      return;
    }

    await ctx.room.broadcast({
      type: 'chat.message',
      id: crypto.randomUUID(),
      name: state.name,
      text: event.text,
      sentAt: new Date().toISOString(),
    });
  },
  async onClose(ctx) {
    const state = (ctx.connection.state as ChatConnectionState | undefined) ?? {};
    if (!state.name) {
      return;
    }

    const remaining = Math.max(0, activeConnectionCount(ctx.room) - 1);
    await ctx.room.broadcast({
      type: 'chat.system',
      id: crypto.randomUUID(),
      text: `${state.name} left ${ctx.params.room}`,
      activeConnections: remaining,
    });
  },
  onRequest(ctx) {
    return Response.json({
      ok: true,
      room: ctx.params.room,
      kind: 'room',
    });
  },
});

export default definition;
