import { users } from '@schema';
import { db } from 'void/db';
import { kv } from 'void/kv';

export default defineEventHandler(async () => {
  const rows = await db.select().from(users).limit(1);
  const result = rows[0] ?? null;

  await kv.put('smoke', 'ok');
  const kvValue = await kv.get<string>('smoke');

  return { user: result, kvValue };
});
