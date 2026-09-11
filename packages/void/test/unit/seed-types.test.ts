import { describe, expect, it } from 'vite-plus/test';
import { integer, sqliteTable, text as sqliteText } from '../../src/runtime/schema-d1.ts';
import { int, mysqlTable, text as mysqlText } from '../../src/runtime/schema-mysql.ts';
import { pgTable, serial, text as pgText, timestamp } from '../../src/runtime/schema-pg.ts';
import { defineSeed } from '../../src/runtime/seed.ts';

const sqliteSchema = {
  messages: sqliteTable('messages', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: sqliteText('text').notNull(),
  }),
};

const postgresSchema = {
  messages: pgTable('messages', {
    id: serial('id').primaryKey(),
    text: pgText('text').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  }),
};

const mysqlSchema = {
  messages: mysqlTable('messages', {
    id: int('id').autoincrement().primaryKey(),
    text: mysqlText('text').notNull(),
  }),
};

type PostgresSchema = typeof postgresSchema;
type SqliteSchema = typeof sqliteSchema;
type MySqlSchema = typeof mysqlSchema;

const sqliteSeed = defineSeed<SqliteSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from sqlite' }]);
});

const postgresSeed = defineSeed<PostgresSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from postgresql' }]);
});

const mysqlSeed = defineSeed<MySqlSchema>(async ({ db, schema }) => {
  await db.insert(schema.messages).values([{ text: 'hello from mysql' }]);
});

describe('defineSeed types', () => {
  it('accepts generated seed callbacks for schema-specific dialects', () => {
    expect(typeof sqliteSeed).toBe('function');
    expect(typeof postgresSeed).toBe('function');
    expect(typeof mysqlSeed).toBe('function');
  });
});
