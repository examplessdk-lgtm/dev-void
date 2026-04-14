import { defineHandler, defer } from 'void';
import type { Deferred } from 'void';

export interface Props {
  title: string;
  stats: Deferred<{ count: number }>;
}

export const loader = defineHandler<Props>(() => {
  return {
    title: 'Deferred Page',
    stats: defer(async () => ({ count: 42 })),
  };
});
