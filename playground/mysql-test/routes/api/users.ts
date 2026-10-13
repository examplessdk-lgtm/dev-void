import { users } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const GET = defineHandler(async () => {
  const all = await db.select().from(users);
  return all;
});
