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

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{
    intent: string;
    name?: string;
    email?: string;
    title?: string;
    body?: string;
    authorId?: number;
    id?: number;
  }>();

  if (body.intent === "create-user") {
    await db.insert(users).values({ name: body.name!, email: body.email! });
  } else if (body.intent === "delete-user") {
    await db.delete(posts).where(eq(posts.authorId, body.id!));
    await db.delete(users).where(eq(users.id, body.id!));
  } else if (body.intent === "create-post") {
    await db.insert(posts).values({
      title: body.title!,
      body: body.body!,
      authorId: body.authorId!,
    });
  } else if (body.intent === "delete-post") {
    await db.delete(posts).where(eq(posts.id, body.id!));
  }
});
