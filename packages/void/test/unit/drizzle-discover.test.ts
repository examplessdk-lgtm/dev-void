import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSchema } from "../../src/drizzle/discover";

describe("discoverSchema", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `void-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds db/schema.ts", () => {
    mkdirSync(join(root, "db"), { recursive: true });
    writeFileSync(join(root, "db/schema.ts"), "export const users = {};");
    const result = discoverSchema(root);
    expect(result).toEqual({ type: "file", path: join(root, "db/schema.ts") });
  });

  it("finds db/schema/ directory", () => {
    mkdirSync(join(root, "db/schema"), { recursive: true });
    writeFileSync(join(root, "db/schema/users.ts"), "export const users = {};");
    writeFileSync(join(root, "db/schema/posts.ts"), "export const posts = {};");
    const result = discoverSchema(root);
    expect(result).toEqual({
      type: "directory",
      path: join(root, "db/schema"),
    });
  });

  it("prefers db/schema.ts over db/schema/ directory", () => {
    mkdirSync(join(root, "db/schema"), { recursive: true });
    writeFileSync(join(root, "db/schema.ts"), "export const users = {};");
    writeFileSync(join(root, "db/schema/users.ts"), "export const users = {};");
    const result = discoverSchema(root);
    expect(result).toEqual({ type: "file", path: join(root, "db/schema.ts") });
  });

  it("returns null when no schema found", () => {
    const result = discoverSchema(root);
    expect(result).toBeNull();
  });
});
