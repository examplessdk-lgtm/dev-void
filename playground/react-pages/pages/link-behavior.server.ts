import { defineHandler, defineHead } from 'void';

export interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: 'Link Behavior' };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.title,
    link: [
      { rel: 'stylesheet', href: '/hash-navigation-test.css' },
      {
        rel: 'preload',
        href: '/hash-navigation-test.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
    ],
  };
});
