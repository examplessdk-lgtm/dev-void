import { users, posts } from '@schema';
import { defineHandler } from 'void';
import { db, eq } from 'void/db';

export const GET = defineHandler(async () => {
  const all = await db
    .select({
      id: posts.id,
      title: posts.title,
      body: posts.body,
      author: users.name,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id));
  return all;
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ title: string; body: string; authorId: number }>();
  const [created] = await db
    .insert(posts)
    .values({ title: body.title, body: body.body, authorId: body.authorId })
    .returning();
  return c.json(created, 201);
});
