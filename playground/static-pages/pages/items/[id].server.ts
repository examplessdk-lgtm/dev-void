import { defineHandler } from 'void';

export interface Props {
  id: string;
}

export const loader = defineHandler<Props>((c) => {
  return { id: c.req.param('id') };
});
