import { describe, it, expect } from "vitest";

import {
  parseMigrationSchema,
  stripComments,
  splitStatements,
  splitColumnDefs,
  parseColumnDef,
  mapSqliteType,
} from "../../src/migrations/schema";

describe("mapSqliteType", () => {
  it("maps INT types to INTEGER", () => {
    expect(mapSqliteType("INTEGER")).toBe("INTEGER");
    expect(mapSqliteType("INT")).toBe("INTEGER");
    expect(mapSqliteType("BIGINT")).toBe("INTEGER");
    expect(mapSqliteType("TINYINT")).toBe("INTEGER");
    expect(mapSqliteType("SMALLINT")).toBe("INTEGER");
  });

  it("maps TEXT types to TEXT", () => {
    expect(mapSqliteType("TEXT")).toBe("TEXT");
    expect(mapSqliteType("VARCHAR")).toBe("TEXT");
    expect(mapSqliteType("CHARACTER")).toBe("TEXT");
    expect(mapSqliteType("CLOB")).toBe("TEXT");
  });

  it("maps REAL types to REAL", () => {
    expect(mapSqliteType("REAL")).toBe("REAL");
    expect(mapSqliteType("FLOAT")).toBe("REAL");
    expect(mapSqliteType("DOUBLE")).toBe("REAL");
  });

  it("maps BLOB and empty to BLOB", () => {
    expect(mapSqliteType("BLOB")).toBe("BLOB");
    expect(mapSqliteType("")).toBe("BLOB");
  });

  it("maps unknown types to TEXT as fallback", () => {
    expect(mapSqliteType("BOOLEAN")).toBe("TEXT");
    expect(mapSqliteType("NUMERIC")).toBe("TEXT");
  });
});

describe("stripComments", () => {
  it("strips single-line comments", () => {
    expect(stripComments("SELECT 1; -- comment\nSELECT 2;")).toBe("SELECT 1; \nSELECT 2;");
  });

  it("strips block comments", () => {
    expect(stripComments("SELECT /* block */ 1;")).toBe("SELECT  1;");
  });

  it("preserves strings containing comment-like syntax", () => {
    expect(stripComments("INSERT INTO t VALUES ('hello -- world');")).toBe(
      "INSERT INTO t VALUES ('hello -- world');",
    );
  });

  it("handles escaped quotes in strings", () => {
    expect(stripComments("INSERT INTO t VALUES ('it''s');")).toBe(
      "INSERT INTO t VALUES ('it''s');",
    );
  });
});

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("CREATE TABLE a; CREATE TABLE b")).toEqual([
      "CREATE TABLE a",
      "CREATE TABLE b",
    ]);
  });

  it("respects parenthesized expressions", () => {
    const sql = "CREATE TABLE a (id INT; name TEXT); SELECT 1";
    const result = splitStatements(sql);
    // The semicolon inside parens is at depth > 0, so it shouldn't split
    // (but this is a quirky edge case — real SQL wouldn't have ; inside column defs)
    // Actually our parser splits at depth 0 only
    expect(result.length).toBe(2);
  });

  it("handles empty input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("  ")).toEqual([]);
  });
});

describe("splitColumnDefs", () => {
  it("splits simple column defs", () => {
    expect(splitColumnDefs("id INTEGER, name TEXT")).toEqual(["id INTEGER", "name TEXT"]);
  });

  it("handles DEFAULT with parenthesized expression", () => {
    const defs = splitColumnDefs("id INTEGER, created_at TEXT DEFAULT (datetime('now'))");
    expect(defs).toEqual(["id INTEGER", "created_at TEXT DEFAULT (datetime('now'))"]);
  });
});

describe("parseColumnDef", () => {
  it("parses simple column", () => {
    const col = parseColumnDef("name TEXT");
    expect(col).toEqual({
      name: "name",
      type: "TEXT",
      nullable: true,
      hasDefault: false,
      primaryKey: false,
    });
  });

  it("parses NOT NULL column", () => {
    const col = parseColumnDef("email TEXT NOT NULL");
    expect(col).toEqual({
      name: "email",
      type: "TEXT",
      nullable: false,
      hasDefault: false,
      primaryKey: false,
    });
  });

  it("parses PRIMARY KEY AUTOINCREMENT", () => {
    const col = parseColumnDef("id INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(col).toEqual({
      name: "id",
      type: "INTEGER",
      nullable: false,
      hasDefault: true,
      primaryKey: true,
    });
  });

  it("parses column with DEFAULT", () => {
    const col = parseColumnDef("active INTEGER NOT NULL DEFAULT 1");
    expect(col).toEqual({
      name: "active",
      type: "INTEGER",
      nullable: false,
      hasDefault: true,
      primaryKey: false,
    });
  });

  it("parses column with DEFAULT expression", () => {
    const col = parseColumnDef("created_at TEXT DEFAULT (datetime('now'))");
    expect(col).toEqual({
      name: "created_at",
      type: "TEXT",
      nullable: true,
      hasDefault: true,
      primaryKey: false,
    });
  });

  it("parses column with no type", () => {
    const col = parseColumnDef("data");
    expect(col).toEqual({
      name: "data",
      type: "BLOB",
      nullable: true,
      hasDefault: false,
      primaryKey: false,
    });
  });

  it("parses quoted column name", () => {
    const col = parseColumnDef('"user-name" TEXT');
    expect(col).toEqual({
      name: "user-name",
      type: "TEXT",
      nullable: true,
      hasDefault: false,
      primaryKey: false,
    });
  });
});

describe("parseMigrationSchema", () => {
  it("parses a simple CREATE TABLE", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL
        );`,
      },
    ]);

    expect(schema.size).toBe(1);
    const users = schema.get("users")!;
    expect(users.name).toBe("users");
    expect(users.columns).toHaveLength(3);
    expect(users.columns[0]).toEqual({
      name: "id",
      type: "INTEGER",
      nullable: false,
      hasDefault: true,
      primaryKey: true,
    });
    expect(users.columns[1]).toEqual({
      name: "name",
      type: "TEXT",
      nullable: false,
      hasDefault: false,
      primaryKey: false,
    });
  });

  it("handles CREATE TABLE IF NOT EXISTS", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT);",
      },
    ]);
    expect(schema.has("items")).toBe(true);
    expect(schema.get("items")!.columns).toHaveLength(2);
  });

  it("handles ALTER TABLE ADD COLUMN", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
      { name: "002.sql", sql: "ALTER TABLE users ADD COLUMN name TEXT;" },
    ]);

    expect(schema.get("users")!.columns).toHaveLength(2);
    expect(schema.get("users")!.columns[1].name).toBe("name");
  });

  it("handles ALTER TABLE ADD without COLUMN keyword", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
      { name: "002.sql", sql: "ALTER TABLE users ADD email TEXT NOT NULL;" },
    ]);

    expect(schema.get("users")!.columns).toHaveLength(2);
    expect(schema.get("users")!.columns[1]).toMatchObject({
      name: "email",
      type: "TEXT",
      nullable: false,
    });
  });

  it("handles ALTER TABLE DROP COLUMN", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);",
      },
      { name: "002.sql", sql: "ALTER TABLE users DROP COLUMN email;" },
    ]);

    expect(schema.get("users")!.columns).toHaveLength(2);
    expect(schema.get("users")!.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("handles ALTER TABLE RENAME COLUMN", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);" },
      { name: "002.sql", sql: "ALTER TABLE users RENAME COLUMN name TO full_name;" },
    ]);

    expect(schema.get("users")!.columns[1].name).toBe("full_name");
  });

  it("handles ALTER TABLE RENAME TO", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
      { name: "002.sql", sql: "ALTER TABLE users RENAME TO people;" },
    ]);

    expect(schema.has("users")).toBe(false);
    expect(schema.has("people")).toBe(true);
    expect(schema.get("people")!.name).toBe("people");
  });

  it("handles DROP TABLE", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);" },
      { name: "002.sql", sql: "DROP TABLE users;" },
    ]);

    expect(schema.size).toBe(0);
  });

  it("handles DROP TABLE IF EXISTS", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "DROP TABLE IF EXISTS nonexistent;" },
    ]);

    expect(schema.size).toBe(0);
  });

  it("ignores non-DDL statements", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `
          CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
          INSERT INTO users (name) VALUES ('Alice');
          CREATE INDEX idx_name ON users (name);
        `,
      },
    ]);

    expect(schema.size).toBe(1);
    expect(schema.get("users")!.columns).toHaveLength(2);
  });

  it("handles comments in SQL", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `
          -- Create users table
          CREATE TABLE users (
            id INTEGER PRIMARY KEY, /* auto-increment */
            name TEXT NOT NULL
          );
        `,
      },
    ]);

    expect(schema.get("users")!.columns).toHaveLength(2);
  });

  it("handles multiple tables across migrations", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
      },
      {
        name: "002.sql",
        sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);",
      },
    ]);

    expect(schema.size).toBe(2);
    expect(schema.get("users")!.columns).toHaveLength(2);
    expect(schema.get("posts")!.columns).toHaveLength(3);
  });

  it("handles empty migrations", () => {
    const schema = parseMigrationSchema([]);
    expect(schema.size).toBe(0);
  });

  it("handles migration with only non-DDL", () => {
    const schema = parseMigrationSchema([
      { name: "001.sql", sql: "INSERT INTO users (name) VALUES ('Bob');" },
    ]);
    expect(schema.size).toBe(0);
  });

  it("handles table constraints (PRIMARY KEY, FOREIGN KEY)", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `CREATE TABLE orders (
          id INTEGER,
          user_id INTEGER,
          product TEXT NOT NULL,
          PRIMARY KEY (id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );`,
      },
    ]);

    const orders = schema.get("orders")!;
    expect(orders.columns).toHaveLength(3);
    // id should be marked as primary key from the table constraint
    expect(orders.columns[0]).toMatchObject({
      name: "id",
      primaryKey: true,
      nullable: false,
    });
  });

  it("handles DEFAULT expression with commas inside parens", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          data TEXT DEFAULT ('a,b,c'),
          ts TEXT DEFAULT (strftime('%Y-%m-%d','now'))
        );`,
      },
    ]);

    const events = schema.get("events")!;
    expect(events.columns).toHaveLength(3);
    expect(events.columns[1]).toMatchObject({ name: "data", hasDefault: true });
    expect(events.columns[2]).toMatchObject({ name: "ts", hasDefault: true });
  });

  it("handles all SQLite type affinities", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `CREATE TABLE types (
          a INTEGER,
          b REAL,
          c TEXT,
          d BLOB,
          e VARCHAR,
          f BIGINT,
          g FLOAT,
          h DOUBLE
        );`,
      },
    ]);

    const types = schema.get("types")!;
    expect(types.columns.map((c) => c.type)).toEqual([
      "INTEGER",
      "REAL",
      "TEXT",
      "BLOB",
      "TEXT",
      "INTEGER",
      "REAL",
      "REAL",
    ]);
  });

  it("handles nullable vs non-nullable columns", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: `CREATE TABLE t (
          a TEXT,
          b TEXT NOT NULL,
          c INTEGER PRIMARY KEY
        );`,
      },
    ]);

    const t = schema.get("t")!;
    expect(t.columns[0].nullable).toBe(true);
    expect(t.columns[1].nullable).toBe(false);
    expect(t.columns[2].nullable).toBe(false); // PK is not nullable
  });

  it("evolves schema across multiple migrations", () => {
    const schema = parseMigrationSchema([
      {
        name: "001.sql",
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
      },
      {
        name: "002.sql",
        sql: "ALTER TABLE users ADD COLUMN email TEXT;",
      },
      {
        name: "003.sql",
        sql: "ALTER TABLE users RENAME COLUMN name TO full_name;",
      },
      {
        name: "004.sql",
        sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      },
    ]);

    expect(schema.size).toBe(2);
    const users = schema.get("users")!;
    expect(users.columns.map((c) => c.name)).toEqual(["id", "full_name", "email"]);
    expect(schema.get("posts")!.columns).toHaveLength(2);
  });

  it("parses the playground migration correctly", () => {
    const schema = parseMigrationSchema([
      {
        name: "001_create_users.sql",
        sql: `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');
        INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com');`,
      },
    ]);

    const users = schema.get("users")!;
    expect(users.columns).toHaveLength(4);
    expect(users.columns[0]).toMatchObject({
      name: "id",
      type: "INTEGER",
      primaryKey: true,
      hasDefault: true,
      nullable: false,
    });
    expect(users.columns[3]).toMatchObject({
      name: "created_at",
      type: "TEXT",
      nullable: true,
      hasDefault: true,
    });
  });
});
