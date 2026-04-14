import { defineHandler, defineHead } from 'void';

export interface Props {
  highlights: Array<{
    title: string;
    body: string;
    href: string;
  }>;
}

export const loader = defineHandler<Props>(() => {
  return {
    highlights: [
      {
        title: 'Chat room via defineRoom()',
        body: 'One Durable Object instance per room slug. Broadcast join events, typed messages, and keep per-connection profile state.',
        href: '/chat',
      },
      {
        title: 'Single socket notifications',
        body: 'A single websocket streams notifications over time, supports stop and restart, and sends typed ack events back to the browser.',
        href: '/notifications',
      },
    ],
  };
});

export const head = defineHead<Props>(() => {
  return {
    title: 'Overview',
    meta: [{ name: 'description', content: 'Void WebSocket playground demos' }],
  };
});
