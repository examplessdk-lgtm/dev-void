import { defineHandler, defineHead } from 'void';
import { LIVE_PLAYGROUND_TOPIC } from '../src/live.ts';

export type Props = Readonly<{
  topic: string;
}>;

export const loader = defineHandler<Props>(() => {
  return { topic: LIVE_PLAYGROUND_TOPIC };
});

export const head = defineHead<Props>(() => {
  return {
    title: 'Live Streams',
    meta: [{ name: 'description', content: 'Live stream playground for React Pages' }],
  };
});
