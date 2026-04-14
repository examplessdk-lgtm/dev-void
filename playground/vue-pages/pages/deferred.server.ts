import { defineHandler, defer } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    title: 'Deferred Page',
    stats: defer(async () => ({ count: 42 })),
  };
});
