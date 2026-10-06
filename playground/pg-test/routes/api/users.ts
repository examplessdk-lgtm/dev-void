import { users } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const GET = defineHandler(async () => {
  const all = await db.select().from(users);
  return all;
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ name: string; email: string }>();
  const [created] = await db
    .insert(users)
    .values({ name: body.name, email: body.email })
    .returning();
  return c.json(created, 201);
});
