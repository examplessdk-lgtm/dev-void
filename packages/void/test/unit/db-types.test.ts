import { describe, it, expect } from "vitest";

import type { SchemaMap, TableSchema } from "../../src/migrations/schema";

import { generateDbTypes } from "../../src/codegen/db-types";

function makeSchema(tables: TableSchema[]): SchemaMap {
  const map: SchemaMap = new Map();
  for (const t of tables) map.set(t.name, t);
  return map;
}

describe("generateDbTypes", () => {
  it("generates module augmentation structure", () => {
    const output = generateDbTypes(new Map());
    expect(output).toContain('declare module "void/db"');
    expect(output).toContain("interface DbTables");
    expect(output).toContain("interface DbInsertTables");
  });

  it("generates empty interfaces for empty schema", () => {
    const output = generateDbTypes(new Map());
    // Empty interfaces still have opening/closing braces
    expect(output).toContain("interface DbTables {");
    expect(output).toContain("interface DbInsertTables {");
    // Should not contain any table entries
    expect(output).not.toMatch(/^\s{4}\w/m);
  });

  it("maps INTEGER and REAL to number", () => {
    const schema = makeSchema([
      {
        name: "t",
        columns: [
          { name: "a", type: "INTEGER", nullable: false, hasDefault: false, primaryKey: false },
          { name: "b", type: "REAL", nullable: false, hasDefault: false, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);
    expect(output).toContain("a: number;");
    expect(output).toContain("b: number;");
  });

  it("maps TEXT to string", () => {
    const schema = makeSchema([
      {
        name: "t",
        columns: [
          { name: "s", type: "TEXT", nullable: false, hasDefault: false, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);
    expect(output).toContain("s: string;");
  });

  it("maps BLOB to ArrayBuffer", () => {
    const schema = makeSchema([
      {
        name: "t",
        columns: [
          { name: "d", type: "BLOB", nullable: false, hasDefault: false, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);
    expect(output).toContain("d: ArrayBuffer;");
  });

  it("adds | null for nullable columns", () => {
    const schema = makeSchema([
      {
        name: "t",
        columns: [
          { name: "a", type: "TEXT", nullable: true, hasDefault: false, primaryKey: false },
          { name: "b", type: "TEXT", nullable: false, hasDefault: false, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);
    expect(output).toContain("a: string | null;");
    expect(output).toContain("b: string;");
    // Make sure b doesn't have null
    expect(output).not.toMatch(/b: string \| null/);
  });

  it("makes PK and DEFAULT columns optional in DbInsertTables", () => {
    const schema = makeSchema([
      {
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false, hasDefault: true, primaryKey: true },
          { name: "name", type: "TEXT", nullable: false, hasDefault: false, primaryKey: false },
          { name: "created_at", type: "TEXT", nullable: true, hasDefault: true, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);

    // In DbTables: all required
    expect(output).toMatch(/interface DbTables \{[\s\S]*?id: number;/);

    // In DbInsertTables: id and created_at are optional
    expect(output).toMatch(/interface DbInsertTables \{[\s\S]*?id\?: number;/);
    expect(output).toMatch(/interface DbInsertTables \{[\s\S]*?name: string;/);
    expect(output).toMatch(/interface DbInsertTables \{[\s\S]*?created_at\?: string \| null;/);
  });

  it("generates types for multiple tables", () => {
    const schema = makeSchema([
      {
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false, hasDefault: false, primaryKey: true },
        ],
      },
      {
        name: "posts",
        columns: [
          { name: "id", type: "INTEGER", nullable: false, hasDefault: false, primaryKey: true },
          { name: "title", type: "TEXT", nullable: false, hasDefault: false, primaryKey: false },
        ],
      },
    ]);
    const output = generateDbTypes(schema);
    expect(output).toContain("users:");
    expect(output).toContain("posts:");
    expect(output).toContain("title: string;");
  });
});
