import { defineHandler } from 'void';

export interface Props {
  title: string;
  runtime: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: 'Home', runtime: process.versions.node };
});
