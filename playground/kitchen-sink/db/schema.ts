import { sqliteTable, integer, text } from "void/schema-d1";
import { sql } from "void/db";

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const queueResults = sqliteTable("queue_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull(),
  value: text("value").notNull().default(""),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
