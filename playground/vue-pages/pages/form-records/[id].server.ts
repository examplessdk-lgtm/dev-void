import { defineHandler } from 'void';

const records = new Map<string, string>();
export type Props = { id: string; name: string };
export const loader = defineHandler<Props>((c) => {
  const id = c.req.param('id')!;
  return { id, name: records.get(id) ?? `Record ${id}` };
});
export const action = defineHandler(async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  records.set(c.req.param('id')!, name);
});
