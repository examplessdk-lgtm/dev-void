import { defineHandler, type InferProps } from "void";
import { db, eq, desc } from "void/db";
import { notes } from "@schema";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const rows = await db.select().from(notes).orderBy(desc(notes.id));
  return { notes: rows };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ intent: string; title?: string; body?: string; id?: number }>();

  if (body.intent === "create") {
    await db.insert(notes).values({ title: body.title!, body: body.body ?? "" });
  } else if (body.intent === "delete") {
    await db.delete(notes).where(eq(notes.id, body.id!));
  }
});
