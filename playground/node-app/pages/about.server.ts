import { defineHandler, defineHead } from 'void';

export interface Props {
  description: string;
}

export const loader = defineHandler<Props>(() => {
  return { description: 'A demo of Void running on Node.js with React Pages.' };
});

export const head = defineHead<Props>(() => {
  return { title: 'About' };
});
