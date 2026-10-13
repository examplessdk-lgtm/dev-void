import { users } from '@schema';
import { defineEventHandler } from 'h3';
import { db } from 'void/db';
import { kv } from 'void/kv';

export default defineEventHandler(async () => {
  const rows = await db.select().from(users).limit(1);
  const result = rows[0] ?? null;
  // The relational API needs the app's schema in `void/db`.
  const first = await db.query.users.findFirst({ columns: { name: true } });

  await kv.put('smoke', 'ok');
  const kvValue = await kv.get<string>('smoke');

  return { user: result, firstUser: first ?? null, kvValue };
});
