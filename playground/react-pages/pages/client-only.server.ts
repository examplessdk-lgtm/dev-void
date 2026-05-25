import { defineHandler, defineHead, type InferProps } from 'void';

export const ssr = false;

export const loader = defineHandler(() => ({
  title: 'Client-only Route',
  marker: 'loader-props-available',
}));

export type Props = InferProps<typeof loader>;

export const head = defineHead<Props>((_c, props) => ({
  title: props.title,
  meta: [{ name: 'description', content: 'React Pages client-only route' }],
}));
