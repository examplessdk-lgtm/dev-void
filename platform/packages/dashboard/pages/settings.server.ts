import { defineHandler } from 'void';
import type { API } from '../lib/api.ts';

export type Props = Readonly<{
  user: API<'me'>;
}>;

export const loader = defineHandler<Props>((context) => {
  return { user: context.get('dashboardUser') };
});
