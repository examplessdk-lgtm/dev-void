import { defineHandler } from 'void';

export interface Props {
  description: string;
}

export const loader = defineHandler<Props>(() => {
  return { description: 'A legacy static page that can be redirected at deploy time.' };
});
