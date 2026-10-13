import { users } from '@schema';
import { defineHandler } from 'void';
import { createDb } from 'void/db';

export const GET = defineHandler(async (c) => {
  const all = await createDb(String(c.env.DATABASE_URL)).select().from(users);
  return all;
});
