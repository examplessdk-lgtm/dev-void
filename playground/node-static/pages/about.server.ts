import { defineHandler } from 'void';

export interface Props {
  description: string;
}

export const loader = defineHandler<Props>(() => {
  return { description: 'A statically prerendered page from Node.js.' };
});
