import { defineHandler, defineHead } from 'void';

export interface Props {
  defaultCount: number;
}

export const loader = defineHandler<Props>(() => {
  return { defaultCount: 5 };
});

export const head = defineHead<Props>(() => {
  return {
    title: 'Notifications',
    meta: [{ name: 'description', content: 'Single-socket streaming websocket demo' }],
  };
});
