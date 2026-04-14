import { users } from '@schema';
import * as v from 'valibot';
import { defineHandler } from 'void';
import { db, eq } from 'void/db';

export const GET = defineHandler.withValidator({
  params: v.object({ id: v.string() }),
})(async (c, { params }) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(params.id)));

  if (!user) {
    return new Response('Not found', { status: 404 });
  }
  return user;
});
