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

  it('generates MySQL auth tables with native column types', () => {
    const code = generateVoidAuthDrizzleSchema({ dialect: 'mysql', providers: null });

    expect(code).toContain('mysqlTable');
    expect(code).toContain('from "void/schema-mysql"');
    expect(code).toContain('boolean("emailVerified")');
    expect(code).toContain('timestamp("createdAt", { mode: "date", fsp: 3 })');
    expect(code).toContain('"dialect": "mysql"');
  });

  it('uses unbounded MySQL text for OAuth tokens while preserving constrained strings', () => {
    const code = generateVoidAuthDrizzleSchema({
      dialect: 'mysql',
      providers: ['google'],
      userConfig: ({ defaults }) => ({
        ...defaults,
        account: {
          fields: { idToken: 'google_id_token' },
          additionalFields: {
            pluginLookup: { type: 'string', index: true },
          },
        },
      }),
    });

    expect(code).toContain('import { boolean, index, mysqlTable, text, timestamp, varchar }');
    expect(code).toContain('"accessToken": text("accessToken")');
    expect(code).toContain('"refreshToken": text("refreshToken")');
    expect(code).toContain('"google_id_token": text("google_id_token")');
    expect(code).toContain('"email": varchar("email", { length: 255 }).notNull().unique()');
    expect(code).toContain('"pluginLookup": varchar("pluginLookup", { length: 255 }).notNull()');
    expect(code).toContain('index("account_pluginLookup_idx").on(table["pluginLookup"])');
    expect(code).toContain('"google_id_token": {');
    expect(code).toContain('"unbounded": true');
  });

  it('gives PostgreSQL serial and uuid ids a database default', () => {
    const generate = (dialect: 'postgresql' | 'mysql', generateId: 'serial' | 'uuid') =>
      generateVoidAuthDrizzleSchema({
        dialect,
        providers: null,
        userConfig: ({ defaults }) => ({ ...defaults, advanced: { database: { generateId } } }),
      });

    expect(generate('postgresql', 'serial')).toContain(
      '"id": integer("id").primaryKey().generatedByDefaultAsIdentity().notNull()',
    );
    expect(generate('postgresql', 'uuid')).toContain(
      '"id": uuid("id").primaryKey().defaultRandom().notNull()',
    );
    expect(generate('mysql', 'serial')).toContain(
      'import { boolean, index, int, mysqlTable, text, timestamp, varchar } from "void/schema-mysql"',
    );
  });

  it('does not add MySQL storage metadata to PostgreSQL or SQLite schemas', () => {
    for (const dialect of ['postgresql', 'sqlite'] as const) {
      const code = generateVoidAuthDrizzleSchema({ dialect, providers: ['google'] });
      expect(code).not.toContain('"unbounded"');
    }
  });

  it('lazily creates an auth database adapter that reuses void/db', () => {
    const code = generateVoidAuthDatabaseModule({
      dialect: 'postgresql',
      schemaImportPath: '/project/.void/better-auth-schema.ts',
      drizzleAdapterPath: '/resolved/better-auth/adapters/drizzle.mjs',
    });

    expect(code).toContain('import { db as __voidDb } from "void/db"');
    expect(code).toContain(
      'let __voidAuthDatabaseInstance: ReturnType<typeof drizzleAdapter> | undefined;',
    );
    expect(code).toContain(
      'export const __voidAuthDatabase: ReturnType<typeof drizzleAdapter> = (options) => {',
    );
    expect(code).toContain('__voidAuthDatabaseInstance ??= drizzleAdapter(__voidDb');
    expect(code).toContain('return __voidAuthDatabaseInstance(options);');
    expect(code).not.toContain('export const __voidAuthDatabase = drizzleAdapter(__voidDb');
    expect(code).not.toContain('import pg from');
  });
});
