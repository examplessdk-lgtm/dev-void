import { defineHandler } from "void";
import { db } from "void/db";
import { notes, queueResults } from "@schema";
import { kv } from "void/kv";
import { storage } from "void/storage";

export const POST = defineHandler(async () => {
  // Clear all D1 tables
  await db.delete(notes);
  await db.delete(queueResults);

  // Clear all KV keys (paginated)
  let kvComplete = false;
  let kvCursor: string | undefined;
  while (!kvComplete) {
    const result = await kv.list({ limit: 1000, cursor: kvCursor });
    await Promise.all(result.keys.map((k) => kv.delete(k.name)));
    kvComplete = result.list_complete;
    kvCursor = result.cursor;
  }

  // Clear all R2 objects (paginated)
  let r2Cursor: string | undefined;
  for (;;) {
    const result = await storage.list({ limit: 1000, cursor: r2Cursor });
    await Promise.all(result.objects.map((obj) => storage.delete(obj.key)));
    if (!result.truncated) break;
    r2Cursor = result.cursor;
  }

  return { ok: true };
});
