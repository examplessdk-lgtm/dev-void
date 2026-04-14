import { defineHandler } from 'void';

export interface Props {
  content: string;
}

export const loader = defineHandler<Props>(() => {
  return { content: 'About page content' };
});
