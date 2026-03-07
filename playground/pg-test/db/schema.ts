import { pgTable, serial, text, boolean, timestamp } from "void/schema-pg";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  authorId: serial("author_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
