import { minLength, pipe } from 'valibot';
import { createInsertSchema } from 'void/drizzle-valibot';
import { pgTable, serial, integer, text, boolean, timestamp } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => pipe(schema, minLength(1)),
  email: (schema) => pipe(schema, minLength(1)),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const insertPostSchema = createInsertSchema(posts, {
  title: (schema) => pipe(schema, minLength(1)),
});
