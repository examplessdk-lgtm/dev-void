import { defineHandler, defineHead } from 'void';

export interface Props {
  initialRoom: string;
  initialName: string;
}

export const loader = defineHandler<Props>(() => {
  return {
    initialRoom: 'general',
    initialName: 'guest',
  };
});

export const head = defineHead<Props>(() => {
  return {
    title: 'Chat Room',
    meta: [{ name: 'description', content: 'Typed room-based websocket chat demo' }],
  };
});
