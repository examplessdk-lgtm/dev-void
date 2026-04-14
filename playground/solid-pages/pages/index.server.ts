import { defineHandler } from 'void';

export interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: 'Home' };
});
