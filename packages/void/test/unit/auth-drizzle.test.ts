import { describe, expect, it } from 'vite-plus/test';
import {
  generateVoidAuthDatabaseModule,
  generateVoidAuthDrizzleSchema,
} from '../../src/auth/drizzle.ts';

describe('Better Auth Drizzle codegen', () => {
  it('generates sqlite auth tables with Drizzle-friendly types', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'sqlite',
      providers: null,
    });

    expect(code).toContain('import { index, integer, sqliteTable, text } from "void/schema-d1"');
    expect(code).toContain('export const userTable = sqliteTable("user"');
    expect(code).toContain('"id": text("id").primaryKey().notNull()');
    expect(code).toContain(
      '"emailVerified": integer("emailVerified", { mode: "boolean" }).notNull()',
    );
    expect(code).toContain('"createdAt": integer("createdAt", { mode: "timestamp_ms" }).notNull()');
    expect(code).toContain(
      '"userId": text("userId").notNull().references(() => userTable["id"], { onDelete: "cascade" })',
    );
    expect(code).toContain('index("session_userId_idx").on(table["userId"])');
    expect(code).toContain('"user": userTable');
    expect(code).toContain('export const migrationSchema = {');
    expect(code).toContain('"dialect": "sqlite"');
  });

  it('keeps schema keys stable when users rename tables and columns', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'postgresql',
      providers: ['github'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        user: {
          modelName: 'members',
          fields: {
            email: 'email_address',
          },
        },
      }),
    });

    expect(code).toContain(
      'import { boolean, index, pgTable, text, timestamp } from "void/schema-pg"',
    );
    expect(code).toContain('export const userTable = pgTable("members"');
    expect(code).toContain('"email_address": text("email_address").notNull().unique()');
    expect(code).toContain('"user": userTable');
    expect(code).toContain('"name": "members"');
  });

  it('can generate an auth database module that reuses void/db', () => {
    const code = generateVoidAuthDatabaseModule({
      dialect: 'postgresql',
      schemaImportPath: '/project/.void/better-auth-schema.ts',
      drizzleAdapterPath: '/resolved/better-auth/adapters/drizzle.mjs',
    });

    expect(code).toContain('import { db as __voidDb } from "void/db"');
    expect(code).toContain('drizzleAdapter(__voidDb');
    expect(code).not.toContain('import pg from');
  });
});
