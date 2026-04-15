import { defineHandler, defineHead } from 'void';

export interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: 'Link Behavior' };
});

export const head = defineHead<Props>((c, props) => {
  return { title: props.title };
});
