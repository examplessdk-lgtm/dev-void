import { db } from "void/db";
import { kv } from "void/kv";
import { users } from "@schema";

export async function load() {
  const rows = await db.select().from(users).limit(1);
  const user = rows[0] ?? null;

  await kv.put("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return { d1User: user, kvValue };
}
