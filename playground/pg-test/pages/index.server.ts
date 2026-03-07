import { defineHandler, type InferProps } from "void";
import { db, eq, desc } from "void/db";
import { users, posts } from "@schema";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const allUsers = await db.select().from(users).orderBy(desc(users.id));
  const allPosts = await db
    .select({
      id: posts.id,
      title: posts.title,
      body: posts.body,
      author: users.name,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .orderBy(desc(posts.id));
  return { users: allUsers, posts: allPosts };
});

export const actions = {
  "create-user": defineHandler(async (c) => {
    const { name, email } = await c.req.json<{ name: string; email: string }>();
    await db.insert(users).values({ name, email });
  }),

  "delete-user": defineHandler(async (c) => {
    const { id } = await c.req.json<{ id: number }>();
    await db.delete(posts).where(eq(posts.authorId, id));
    await db.delete(users).where(eq(users.id, id));
  }),

  "create-post": defineHandler(async (c) => {
    const { title, body, authorId } = await c.req.json<{
      title: string;
      body: string;
      authorId: number;
    }>();
    await db.insert(posts).values({ title, body, authorId });
  }),

  "delete-post": defineHandler(async (c) => {
    const { id } = await c.req.json<{ id: number }>();
    await db.delete(posts).where(eq(posts.id, id));
  }),
};
